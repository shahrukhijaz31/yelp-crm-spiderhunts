import { identityKeys } from "./cleanLeads";
import { weekBounds, type CategoryOption, type CountryOption } from "./filters";
import { Prisma } from "./generated/prisma/client";
import { describeLeadActivity, recordLeadActivity } from "./leadActivity";
import { UNKNOWN_LOCATION, buildTownIndex } from "./leadLocation";
import { fromIsoDate, toCreateData, toLead } from "./leadMapping";
import type { LeadPageMeta, LeadPageQuery, LeadSort, LeadSortKey } from "./leadQuery";
import { normalisePhone, type LeadStats } from "./leadUtils";
import { prisma } from "./prisma";
import {
  CALL_STATUSES,
  LEAD_SOURCES,
  isCalled,
  type CallStatus,
  type Lead,
  type LeadEditableFields,
  type LeadSource,
} from "./types";
import type { LeadWorkCounts, LeadWorkState } from "./workState";

/**
 * Every database query the app makes.
 *
 * Row <-> `Lead` conversion lives next door in `lib/leadMapping.ts` (pure, no
 * client), so this file is only the queries and the validation guarding them.
 */

/**
 * Every lead, in a stable order.
 *
 * Ordered by insertion so a CSV keeps the order it was uploaded in — the
 * worklist is worked top to bottom, and rows that shuffle between page loads
 * are disorienting. `id` breaks ties, because `created_at` has millisecond
 * resolution and a `createMany` writes a whole file inside one millisecond.
 *
 * **This reads the whole table**, and every row it returns is serialised into
 * the HTML of whichever page asked for it. That cost is linear in the size of
 * the workspace and is paid on every visit, so the list of callers is kept as
 * short as it can be. Today it is one screen:
 *
 *   /export  writes every matching row to a file, and "every matching row" is
 *            not a page. There is no smaller honest answer for it.
 *
 * The three screens that used to call it no longer do, because none of them
 * actually wanted the rows:
 *
 *   /meetings  wanted the agenda, which is a `where` — {@link listMeetingLeads}
 *   /reports   wanted aggregates, which Postgres counts — {@link leadStats}
 *   /import    wanted a total, which is a `count(*)` — {@link countLeads}
 *
 * The worklist never did: it goes through {@link listLeadsPage}, so an agent
 * opening the call list downloads twenty rows rather than several thousand.
 */
export async function listLeads(): Promise<Lead[]> {
  const rows = await prisma.lead.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toLead);
}

/**
 * The meetings agenda, and nothing else.
 *
 * `isMeetingLead` (lib/meetings.ts) is "interested, or a date in the diary",
 * and this is that predicate written as a `where` — the same rule, moved from
 * the browser to the database. The Meetings screen used to read the whole table
 * and drop the non-meetings on the client, which meant a workspace of several
 * thousand leads sent all of them to render an agenda of a dozen.
 *
 * Both arms are indexed (`@@index([status])`, `@@index([callbackDate])`), so
 * this stays a pair of index scans as the table grows rather than the
 * sequential read it replaces.
 *
 * The two definitions must not drift: a lead that appears here but fails
 * `isMeetingLead` would be fetched and then silently dropped, and one that
 * fails here but passes it would vanish from the agenda altogether. If the
 * predicate changes, change both.
 */
export async function listMeetingLeads(): Promise<Lead[]> {
  const rows = await prisma.lead.findMany({
    where: { OR: [{ status: "interested" }, { callbackDate: { not: null } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toLead);
}

/**
 * How many leads there are. One `count(*)`, no rows.
 *
 * The Import screen shows this figure and nothing else about the lead set, so
 * it asks for this rather than for the table it was reading to call `.length`
 * on the result.
 */
export async function countLeads(): Promise<number> {
  return prisma.lead.count();
}

// --- the worklist's paginated read ------------------------------------------

/*
 * Why raw SQL for the filter, when everything else here is the typed client.
 *
 * `matchesFilters` (lib/filters.ts) is the definition of what the worklist
 * shows, and the server has to reproduce it *exactly* — a lead that the old
 * in-memory filter kept and a paginated query drops is a lead an agent stops
 * being shown, silently. Every clause below except one has a direct Prisma
 * equivalent; the exception is phone search, which compares digits only, so
 * that typing `4155550182` finds `(415) 555-0182`. That needs
 * `regexp_replace(phone, '[^0-9]', '', 'g')` inside the predicate, and Prisma's
 * `where` has no room for a SQL expression on the *column* side.
 *
 * Splitting the difference (typed `where` plus a second pass for phones) does
 * not work either: the phone match is one arm of an OR with the text match, so
 * the two cannot be separate queries without either losing rows or unioning
 * them by hand — which is more raw SQL, not less.
 *
 * The blast radius is kept small deliberately. The raw statements below select
 * `count(*)` and `id` and nothing else; the page's rows are then fetched
 * through `prisma.lead.findMany` and mapped by the same `toLead` every other
 * read uses, so no column type is ever decoded twice, in two ways, by two
 * layers. Every value is a bound parameter — the only thing built by string
 * concatenation is the shape of the WHERE clause itself.
 */

/**
 * Escape the characters `LIKE` treats as wildcards.
 *
 * Without this a search for `50%` matches every lead, and one for `_` matches
 * all of them too. Postgres's default `LIKE` escape is the backslash, which is
 * why the backslash itself has to go first.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The tab and the filter rail as one `WHERE` clause.
 *
 * Read this beside `isInView` and `matchesFilters` — the cases are in the same
 * order and mean the same things. `Prisma.empty` when nothing is constrained,
 * so the "All leads" tab with no filters is a plain scan and not `WHERE true`.
 */
function leadFilterSql(query: LeadPageQuery): Prisma.Sql {
  const { workState, view, filters, today } = query;
  const clauses: Prisma.Sql[] = [];

  // --- the queue (lib/workState.ts) ---
  // The outermost narrowing, and the only one with no equivalent in
  // `matchesFilters`: New and Called are a property of the row, not of what the
  // agent has ticked. One column, two halves of the table, no overlap and no
  // gap — every lead is in exactly one of them.
  clauses.push(
    workState === "called"
      ? Prisma.sql`l.first_called_at IS NOT NULL`
      : Prisma.sql`l.first_called_at IS NULL`,
  );

  // --- the tab (lib/views.ts) ---
  // `callback_date <= today` covers "due today" and "overdue" in one comparison;
  // NULL callbacks drop out of the comparison on their own, which is exactly
  // what `callbackState` returning "none" does.
  if (view === "callback") {
    clauses.push(Prisma.sql`l.callback_date <= ${today}::date`);
  } else if (view === "overdue") {
    clauses.push(Prisma.sql`l.callback_date < ${today}::date`);
  } else if (view === "issues") {
    // `!lead.website` in JS is true for both null and "", so both here too.
    clauses.push(Prisma.sql`(l.website IS NULL OR l.website = '')`);
  }

  // --- status: empty means "all statuses", never "none" ---
  if (filters.statuses.length > 0) {
    clauses.push(Prisma.sql`l.status::text IN (${Prisma.join(filters.statuses)})`);
  }

  // --- source: empty means "every directory", never "none" — same rule as
  //     status, and the same reason: the filter narrows, it does not exclude ---
  if (filters.sources.length > 0) {
    clauses.push(Prisma.sql`l.source::text IN (${Prisma.join(filters.sources)})`);
  }

  // --- category: a lead matches if it has *any* of them (`&&` is overlap) ---
  if (filters.categories.length > 0) {
    clauses.push(
      Prisma.sql`l.categories && ARRAY[${Prisma.join(filters.categories)}]::text[]`,
    );
  }

  /* --- country (lib/leadLocation.ts) ---
   *
   * An `IN` list with an extra arm for the leads whose address the parser could
   * not read. That arm is the reason `UNKNOWN_LOCATION` exists: `NULL IN ('US')`
   * is NULL and never true, so without it "Unknown location" would be an option
   * that matched nothing at all. See `matchesLocation` in `lib/filters.ts` —
   * same rules, same order.
   */
  if (filters.countries.length > 0) {
    const named = filters.countries.filter((value) => value !== UNKNOWN_LOCATION);
    const arms: Prisma.Sql[] = [];
    if (named.length > 0) {
      arms.push(Prisma.sql`l.country IN (${Prisma.join(named)})`);
    }
    if (filters.countries.length !== named.length) {
      arms.push(Prisma.sql`l.country IS NULL`);
    }
    clauses.push(Prisma.sql`(${Prisma.join(arms, " OR ")})`);
  }

  /*
   * --- demo content (lib/filters.ts `DEMO_FILTERS`) ---
   *
   * The one clause here that leaves `leads`, and it is a semi-join rather than
   * a JOIN on purpose: `EXISTS` stops at the first matching row and cannot
   * duplicate a lead, which a join onto a UNIQUE column would not either — but
   * `EXISTS` says so in the query rather than relying on the reader knowing the
   * constraint. It is driven by `demo_websites.lead_id`, which is that unique
   * index, so each check is one index probe.
   *
   * Nothing is read *out* of the subquery: this decides which leads match, and
   * the demo image and link the screen draws come from `demoSummariesFor`,
   * keyed by the ids this query returns. One question per query.
   */
  if (filters.demo !== "all") {
    const hasRow = Prisma.sql`SELECT 1 FROM demo_websites d WHERE d.lead_id = l.id`;
    switch (filters.demo) {
      // Either link counts as a link, and the comments count as neither: the
      // filter offers "has a demo", "has an image" and "has a link", and a lead
      // whose only demo content is a note about it has none of the three.
      case "any":
        // A row exists only once one of the fields has been saved, but a link
        // cleared off a row that still has an image leaves the row behind — so
        // "has a demo" asks about the fields, not about the row.
        clauses.push(
          Prisma.sql`EXISTS (${hasRow} AND (d.image_storage_key IS NOT NULL OR d.demo_url IS NOT NULL OR d.demo_url_2 IS NOT NULL))`,
        );
        break;
      case "none":
        clauses.push(
          Prisma.sql`NOT EXISTS (${hasRow} AND (d.image_storage_key IS NOT NULL OR d.demo_url IS NOT NULL OR d.demo_url_2 IS NOT NULL))`,
        );
        break;
      case "image":
        clauses.push(Prisma.sql`EXISTS (${hasRow} AND d.image_storage_key IS NOT NULL)`);
        break;
      case "link":
        clauses.push(
          Prisma.sql`EXISTS (${hasRow} AND (d.demo_url IS NOT NULL OR d.demo_url_2 IS NOT NULL))`,
        );
        break;
    }
  }

  // --- callback range (lib/filters.ts `matchesCallback`) ---
  switch (filters.callback) {
    case "today":
      clauses.push(Prisma.sql`l.callback_date = ${today}::date`);
      break;
    case "overdue":
      clauses.push(Prisma.sql`l.callback_date < ${today}::date`);
      break;
    case "any":
      clauses.push(Prisma.sql`l.callback_date IS NOT NULL`);
      break;
    case "none":
      clauses.push(Prisma.sql`l.callback_date IS NULL`);
      break;
    case "week": {
      const { start, end } = weekBounds(today);
      clauses.push(
        Prisma.sql`l.callback_date BETWEEN ${start}::date AND ${end}::date`,
      );
      break;
    }
    case "custom": {
      clauses.push(Prisma.sql`l.callback_date IS NOT NULL`);
      if (filters.callbackFrom) {
        clauses.push(Prisma.sql`l.callback_date >= ${filters.callbackFrom}::date`);
      }
      if (filters.callbackTo) {
        clauses.push(Prisma.sql`l.callback_date <= ${filters.callbackTo}::date`);
      }
      break;
    }
    case "all":
    default:
      break;
  }

  /* --- free text ---
   *
   * The one clause here that cannot use an index. `LIKE '%…%'` over an
   * expression is a sequential scan by construction, and no btree index helps a
   * leading wildcard.
   *
   * WHY THERE IS NO TRIGRAM INDEX. It was considered and deliberately not added.
   * A `pg_trgm` GIN index would have to be on the *expressions* — the four-column
   * `lower(… || ' ' || …)` concatenation and the digits-only `regexp_replace` —
   * because that is what the predicate compares, and two expression indexes
   * bring a `CREATE EXTENSION`, an insert cost on every scraper push, and a
   * second definition of the search that has to stay byte-identical to the one
   * above or it is silently not used. Against a table of a few thousand rows
   * (~1,700 in production today) a scan of this shape is single-digit
   * milliseconds, so all of that would buy nothing measurable.
   *
   * What the cost of a search is bounded by instead: the 200-character cap on
   * the needle (`lib/leadQuery.ts`) and the per-user rate limit on searching at
   * all (`lib/rateLimit.ts`). Revisit the index when the table reaches a size
   * where an `EXPLAIN ANALYZE` of this query is worth the two extra definitions,
   * not before.
   */
  const needle = filters.query.trim().toLowerCase();
  if (needle) {
    // The same four fields `matchesQuery` joins, concatenated in the same order
    // with the same single space, so a needle that spans two of them behaves
    // identically here and there. `owner` is the only nullable one.
    const alternatives: Prisma.Sql[] = [
      Prisma.sql`lower(l.name || ' ' || l.address || ' ' || coalesce(l.owner, '') || ' ' || l.notes) LIKE ${`%${likeEscape(needle)}%`}`,
    ];

    // Three digits is the floor `matchesQuery` sets: below it almost every
    // number in the table contains the needle and the result is noise.
    const digits = normalisePhone(needle);
    if (digits.length >= 3) {
      alternatives.push(
        Prisma.sql`regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`,
      );
    }

    clauses.push(Prisma.sql`(${Prisma.join(alternatives, " OR ")})`);
  }

  return clauses.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`
    : Prisma.empty;
}

/**
 * The sorted column as a SQL expression.
 *
 * Held here, keyed by {@link LeadSortKey}, rather than taking a column name
 * from the caller: `ORDER BY` is the one clause in this query that cannot be a
 * bound parameter, so the only defence against a column name arriving from a
 * URL is that no column name ever does. `parseLeadSearchParams` narrows the
 * query string to one of five keys and this map turns a key into SQL — the two
 * strings interpolated below (`ASC`/`DESC`) come from the same closed set.
 *
 * Three details that decide whether the sort is actually usable:
 *
 *   - **Case-insensitive.** Raw Postgres ordering puts every capitalised name
 *     ahead of every lowercase one, so `Zeta` sorts before `acme`. `lower()`
 *     is what makes an A–Z column read as A–Z.
 *   - **Blanks last, in both directions.** The address and category columns are
 *     often empty and the phone one is nullable; `NULLIF(…, '')` folds "" into
 *     NULL so a fixed `NULLS LAST` sinks all of them either way. Ascending by
 *     address should open with the addresses, not with forty blank cells.
 *   - **Phones compare as digits**, matching how they are *searched* — so
 *     `(415) 555-0182` and `415-555-0182` land beside each other rather than
 *     being separated by their punctuation.
 */
function sortExpression(key: Exclude<LeadSortKey, "default">): Prisma.Sql {
  switch (key) {
    case "name":
      return Prisma.sql`lower(nullif(l.name, ''))`;
    case "phone":
      return Prisma.sql`nullif(regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g'), '')`;
    case "address":
      return Prisma.sql`lower(nullif(l.address, ''))`;
    case "category":
      // `categories[1]` — Postgres arrays are 1-indexed, and the row renders
      // the list in stored order, so the first tag is the one on screen.
      // An empty array indexes to NULL and sinks with the other blanks.
      return Prisma.sql`lower(nullif(l.categories[1], ''))`;
  }
}

/**
 * The full `ORDER BY`, sorted column first and the stable order last.
 *
 * The `created_at, id` tail is not decoration: an `OFFSET` into an order with
 * ties is free to break them differently per statement, which shows some leads
 * twice and hides others as the pager walks. Every lead shares a category with
 * dozens of others, so without a tiebreak that is the common case, not an edge
 * one. Keeping the same tail as {@link listLeads} also means the unsorted table
 * is byte-for-byte the query it was before sorting existed.
 *
 * The two queues have different *defaults*, because they are read for different
 * reasons. New keeps insertion order — a scraped batch is meant to be worked
 * top to bottom, and that has been the worklist's order since it existed.
 * Called is a record rather than a queue, and the question asked of it is "what
 * did I just do", so it leads with the most recently worked: `updated_at`, the
 * column that already tracks exactly that, rather than a second timestamp that
 * would have to be kept in step by hand.
 *
 * A heading click overrides both. An explicit sort is the agent saying what
 * they want the order to be, and it means the same thing in either queue.
 */
function leadOrderSql(sort: LeadSort, workState: LeadWorkState): Prisma.Sql {
  const stable = Prisma.sql`l.created_at ASC, l.id ASC`;
  if (sort.key === "default") {
    return workState === "called"
      ? Prisma.sql`l.updated_at DESC, ${stable}`
      : stable;
  }

  const direction = sort.direction === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return Prisma.sql`${sortExpression(sort.key)} ${direction} NULLS LAST, ${stable}`;
}

export interface LeadPageResult extends LeadPageMeta {
  leads: Lead[];
}

/**
 * One page of the worklist, plus how many rows the filter actually matched.
 *
 * The count is of the *filtered* set, not the table: a tab and a filter that
 * leave 42 leads report 42, and the pager walks those 42. It is a separate
 * statement from the page fetch because `LIMIT` and `count(*)` cannot both be
 * had from one query without a window function that would then be computed for
 * every matching row.
 *
 * `page` is clamped to the last page rather than obeyed. A bookmarked
 * `?page=87` whose filter now matches thirty rows should show the thirty, not
 * an empty table with no way to tell why — so the effective page comes back in
 * the result and the client adopts it.
 *
 * Ordering is {@link leadOrderSql} — the header's chosen column, then the same
 * `created_at, id` tail {@link listLeads} uses. It always ends there: an
 * `OFFSET` into an unstable order shows some leads twice and hides others
 * entirely.
 */
export async function listLeadsPage(query: LeadPageQuery): Promise<LeadPageResult> {
  const where = leadFilterSql(query);
  const orderBy = leadOrderSql(query.sort, query.workState);
  const { pageSize } = query;

  const [{ count: total }] = await prisma.$queryRaw<{ count: number }[]>(
    // `::int` because Postgres counts in bigint, which the driver hands back as
    // a BigInt that `JSON.stringify` then refuses to serialise.
    Prisma.sql`SELECT count(*)::int AS count FROM leads l ${where}`,
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, query.page), totalPages);

  // Two steps rather than `SELECT *`: this statement decides *which* rows, and
  // `findMany` below reads them through the generated client, so column
  // decoding (the `date` columns especially) stays in one place for every read
  // in the app. The second query is a primary-key lookup of at most 100 ids.
  const idRows =
    total === 0
      ? []
      : await prisma.$queryRaw<{ id: string }[]>(
          Prisma.sql`
            SELECT l.id FROM leads l ${where}
            ORDER BY ${orderBy}
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
          `,
        );

  const ids = idRows.map((row) => row.id);
  const rows =
    ids.length > 0 ? await prisma.lead.findMany({ where: { id: { in: ids } } }) : [];

  // `findMany` returns them in whatever order it likes; the page's order was
  // decided above, so it is reapplied here rather than re-sorted.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const leads = ids
    .map((id) => byId.get(id))
    .filter((row) => row !== undefined)
    .map(toLead);

  return { leads, total, page, pageSize, totalPages };
}

// --- the lead workspace's single-row read ------------------------------------

/**
 * One lead, plus the bookkeeping timestamps the workspace's activity trail is
 * built from.
 *
 * Deliberately *not* folded into `Lead`. That type is the shape the table, the
 * export, the CSV parser and the filters all speak, and three timestamps that
 * exactly one screen reads would have to be carried by every one of them —
 * including the CSV path, where `createdAt` has no meaning until the row is
 * written. So the workspace asks for what it needs and the shared type is left
 * alone.
 *
 * Every field here already exists in Postgres (see schema.prisma). Nothing was
 * added to record activity: the timeline is assembled from facts the table has
 * always kept, which is why it can only say what actually happened.
 */
export interface LeadDetail {
  lead: Lead;
  /** ISO instants — the browser formats them in the reader's own timezone. */
  createdAt: string;
  updatedAt: string;
  /** When the lead was first worked, or null while it is still New. */
  firstCalledAt: string | null;
  /** Which import the row arrived in, when it came from one. */
  sourceBatch: string | null;
}

/** One lead by id, or null when the id does not name one. */
export async function getLeadDetail(id: string): Promise<LeadDetail | null> {
  const row = await prisma.lead.findUnique({ where: { id } });
  if (!row) return null;

  return {
    lead: toLead(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    firstCalledAt: row.firstCalledAt?.toISOString() ?? null,
    sourceBatch: row.sourceBatch,
  };
}

/**
 * The lead that comes after this one **in the list the agent opened it from**.
 *
 * This is what makes "Next lead" a workflow rather than a shuffle. The query is
 * the worklist's own — the same queue, tab, filters and sort, built by the same
 * two functions {@link listLeadsPage} uses — so an agent working New + Dental
 * is handed the next New dental lead and never a stranger from the far end of
 * the table.
 *
 * `position` is the 1-based ordinal the current lead occupied when its tab was
 * opened, carried in the URL. It exists for one case, and that case is the
 * common one: saving a call outcome moves a lead from New to Called, so by the
 * time anyone presses Next the current lead is **no longer in the set** and
 * `WHERE id = current` finds nothing. The rows behind it have each shifted up
 * by one, which means the lead now standing at the old ordinal is exactly the
 * one that was next. `coalesce` picks that up when the direct lookup fails, and
 * the whole thing stays one statement.
 *
 * Null when there is nothing after it — the end of the queue, a filter that no
 * longer matches anything, or an id that was never in this list to begin with.
 */
export async function nextLeadId(
  query: LeadPageQuery,
  currentId: string,
  position: number | null,
): Promise<string | null> {
  const where = leadFilterSql(query);
  const orderBy = leadOrderSql(query.sort, query.workState);

  const rows = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`
      WITH ordered AS (
        SELECT l.id, row_number() OVER (ORDER BY ${orderBy}) AS rn
        FROM leads l ${where}
      )
      SELECT id FROM ordered
      WHERE rn = coalesce(
        (SELECT rn + 1 FROM ordered WHERE id = ${currentId}),
        ${position}::bigint
      )
      LIMIT 1
    `,
  );

  return rows[0]?.id ?? null;
}

/**
 * The headline numbers, counted by Postgres instead of by the browser.
 *
 * These used to be `computeStats` over the array the client already had, which
 * was free and exactly consistent with the table below it. Once the client
 * stops holding every lead it cannot count them, so the aggregate moves here —
 * the change README.md named as the point to revisit.
 *
 * Deliberately *not* filtered by the tab or the filter rail. The strip, the tab
 * badges and the status counts in the filter panel all describe the whole
 * workspace ("there are 41 overdue callbacks"); narrowing them by the filter
 * that is currently applied would make the number an agent uses to decide what
 * to work on depend on what they happened to have ticked.
 *
 * `today` is the agent's own date for the reason given in `LeadPageQuery`.
 */
export async function leadStats(today: string): Promise<LeadStats> {
  const todayDate = fromIsoDate(today);
  // Callers validate the format, so this is a programming error rather than bad
  // input — and a null here would turn `callbackDate: todayDate` into "callback
  // is unset", quietly reporting every undated lead as due today.
  if (!todayDate) throw new Error(`leadStats expected YYYY-MM-DD, got ${today}`);

  // One transaction, so the figures describe the same instant. A status total
  // that had counted a lead the callback totals had not would show up as a
  // stat bar that does not add up.
  const [groups, sourceGroups, total, callbackDueToday, callbackOverdue, missingWebsite] =
    await prisma.$transaction([
      // Raw rather than `groupBy` only because `groupBy`'s inferred result type
      // is widened past usefulness by `$transaction`'s tuple; the statement is
      // the one `groupBy` would have written.
      prisma.$queryRaw<{ status: CallStatus; count: number }[]>(
        Prisma.sql`SELECT status::text AS status, count(*)::int AS count FROM leads GROUP BY status`,
      ),
      // Two rows at most, and inside the same transaction as the status counts
      // so the two breakdowns of the same table cannot add up to two different
      // totals on the same screen.
      prisma.$queryRaw<{ source: LeadSource; count: number }[]>(
        Prisma.sql`SELECT source::text AS source, count(*)::int AS count FROM leads GROUP BY source`,
      ),
      prisma.lead.count(),
      prisma.lead.count({ where: { callbackDate: todayDate } }),
      prisma.lead.count({ where: { callbackDate: { lt: todayDate } } }),
      // `!lead.website` again: null and "" are both "no website".
      prisma.lead.count({ where: { OR: [{ website: null }, { website: "" }] } }),
    ]);

  const byStatus = Object.fromEntries(
    CALL_STATUSES.map((status) => [status, 0]),
  ) as Record<CallStatus, number>;
  for (const group of groups) byStatus[group.status] += group.count;

  // Seeded at zero for every source, so a directory nobody has scraped yet
  // still appears in the filter panel — as an option reading "0" rather than as
  // an option that is silently missing.
  const bySource = Object.fromEntries(
    LEAD_SOURCES.map((source) => [source, 0]),
  ) as Record<LeadSource, number>;
  for (const group of sourceGroups) bySource[group.source] += group.count;

  // `isCalled` is "anything but not_called", so the not-called count *is* the
  // uncalled total and there is nothing to add up.
  const notCalled = byStatus.not_called;

  return {
    total,
    called: total - notCalled,
    notCalled,
    byStatus,
    bySource,
    callbackDueToday,
    callbackOverdue,
    missingWebsite,
  };
}

/**
 * The New and Called totals behind the tab badges.
 *
 * Deliberately unfiltered, exactly like {@link leadStats} and for the same
 * reason: these numbers describe the workspace ("there are 843 leads nobody has
 * called"), and an agent uses them to decide what to do next. Narrowing them by
 * whatever is currently typed in the search box would make "how much is left"
 * depend on what happened to be ticked, and the number would drop as they typed
 * without anything having been worked. The *pager* is the filtered count, and
 * it already says so — "Showing 1–20 of 42".
 *
 * One statement rather than two counts, so the pair can never describe two
 * different instants and add up to the wrong total. `FILTER` reads the column
 * once; `::int` for the same reason it appears in `listLeadsPage` — Postgres
 * counts in bigint and `JSON.stringify` refuses to serialise one.
 */
export async function leadWorkCounts(): Promise<LeadWorkCounts> {
  const [row] = await prisma.$queryRaw<{ fresh: number; called: number }[]>(
    Prisma.sql`
      SELECT
        count(*) FILTER (WHERE first_called_at IS NULL)::int     AS fresh,
        count(*) FILTER (WHERE first_called_at IS NOT NULL)::int AS called
      FROM leads
    `,
  );

  return { new: row?.fresh ?? 0, called: row?.called ?? 0 };
}

/**
 * Every distinct category in the table, most common first — the list the
 * filter panel offers, previously derived by `collectCategories` from the array
 * in memory.
 *
 * `categories` is a `text[]`, so the rows are expanded with a lateral `unnest`
 * and de-duplicated per lead first: a listing tagged `["Dentist", "Dentist"]`
 * is one dentist, which is what counting in JS with a `Set`-free loop over
 * `lead.categories` also produced. Leads with no categories join to nothing and
 * contribute nothing, as they should.
 *
 * Sorted in JS rather than SQL so ties break by `localeCompare` — the same
 * ordering the panel had before, and one Postgres's collation would not
 * necessarily reproduce.
 */
export async function leadCategories(): Promise<CategoryOption[]> {
  const rows = await prisma.$queryRaw<{ name: string; count: number }[]>(
    Prisma.sql`
      SELECT c AS name, count(*)::int AS count
      FROM (
        SELECT DISTINCT l.id, c
        FROM leads l, LATERAL unnest(l.categories) AS c
      ) tagged
      GROUP BY c
    `,
  );

  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Every country in the table, with a count each — the list the Location group
 * in the filter panel offers.
 *
 * NULL is carried through as {@link UNKNOWN_LOCATION} rather than dropped. A
 * lead whose address defeated the parser is still a lead somebody has to call,
 * and the count of them is the only signal that a shape of address is being
 * missed — hiding it would make the parser look perfect by construction.
 *
 * Called once per page load like `leadCategories` beside it, and served by
 * `leads_country_city_idx`: the grouped column is that index's leading one, so
 * this is an index-only scan rather than a walk over the table.
 */
export async function leadCountries(): Promise<CountryOption[]> {
  const rows = await prisma.$queryRaw<{ country: string | null; count: number }[]>(
    Prisma.sql`
      SELECT country, count(*)::int AS count
      FROM leads
      GROUP BY country
    `,
  );

  // Most common first, ties alphabetical — the ordering `leadCategories` uses,
  // sorted in JS for the same reason: `localeCompare` and not Postgres's
  // collation, so the panel's lists all read the same way.
  return rows
    .map((row) => ({ code: row.country ?? UNKNOWN_LOCATION, count: row.count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * Apply an agent's inline edit. Returns the saved row, or null if it is gone.
 *
 * `actorId` is the signed-in user, supplied by the route handler from the
 * session — never from the request body, which has no say in whose work this
 * is. When it is present the save is also *attributed*: the acts it represents
 * are appended to `lead_activities` (see `lib/leadActivity.ts`), which is the
 * only record anywhere of who worked which lead and therefore the source of
 * every per-agent figure in the portal.
 *
 * Optional so that a caller with no user — a migration, a script, the scraper —
 * can still write a lead without inventing an author for it. Every path a
 * person's work travels does pass one.
 */
export async function updateLeadFields(
  id: string,
  changes: Partial<LeadEditableFields>,
  actorId?: string,
): Promise<Lead | null> {
  // Only the keys actually present are written, so a PATCH carrying just
  // `{ status }` cannot blank out someone's notes.
  const data: Record<string, unknown> = {};
  if ("status" in changes) data.status = changes.status;
  if ("notes" in changes) data.notes = changes.notes;
  if ("callbackDate" in changes) data.callbackDate = fromIsoDate(changes.callbackDate ?? null);
  if ("meetingTime" in changes) data.meetingTime = changes.meetingTime;
  if ("meetingAttendees" in changes) data.meetingAttendees = changes.meetingAttendees;
  if ("meetingNotes" in changes) data.meetingNotes = changes.meetingNotes;
  if ("meetingCompletedAt" in changes) {
    data.meetingCompletedAt = fromIsoDate(changes.meetingCompletedAt ?? null);
  }

  if (Object.keys(data).length === 0) {
    const existing = await prisma.lead.findUnique({ where: { id } });
    return existing ? toLead(existing) : null;
  }

  const row = await prisma.lead.findUnique({ where: { id } });
  if (!row) return null;

  /*
   * New -> Called, and only here.
   *
   * This is the single place a lead crosses over, hung off the save that was
   * already happening rather than a second endpoint or a button. Opening a
   * lead, expanding it, dialling the number or typing into a field reach no
   * write at all, so none of them can move it — which is exactly the rule:
   * saving a call outcome is what counts as having called.
   *
   * Three conditions, each doing real work:
   *
   *   - `"status" in changes` — a save that carries a status is an outcome
   *     being recorded. A notes-only or callback-only PATCH is bookkeeping and
   *     leaves an uncalled lead uncalled.
   *   - `isCalled(...)` — every status except `not_called` is the result of a
   *     call (see CALL_STATUS_LABELS: they read "Called - No answer" and so
   *     on). Explicitly setting a lead *back* to "Not called" is someone
   *     undoing a mis-click, and must not be what promotes it.
   *   - `firstCalledAt === null` — first only. A Called lead being re-worked
   *     keeps the instant it was first called; nothing in the app ever moves
   *     this value or clears it, so no later edit, status change or correction
   *     can send a lead back to the New queue.
   *
   * `updatedAt` is stamped by Prisma on this same write, which is what orders
   * the Called list — so a lead just worked is at the top of it.
   */
  if (
    "status" in changes &&
    changes.status !== undefined &&
    isCalled(changes.status) &&
    row.firstCalledAt === null
  ) {
    data.firstCalledAt = new Date();
  }

  const saved = toLead(await prisma.lead.update({ where: { id }, data }));

  // Attribution, after the lead is safely written and never in its way. The
  // "before" values come from the row already read above, so classifying the
  // save costs no extra query — and awaiting it means a save that returns has
  // been counted, which is what lets an agent watch their own numbers move as
  // they work. A failure inside is logged and swallowed there: reporting must
  // not be the reason a call outcome is lost.
  if (actorId) {
    await recordLeadActivity(id, actorId, describeLeadActivity(toLead(row), changes));
  }

  return saved;
}

/*
 * `replaceAllLeads` used to live here — deleteMany + createMany in one
 * transaction, called by the CSV upload. It was correct while the worklist was
 * React state that a reload discarded anyway, and actively dangerous once the
 * table held real call history: a second import destroyed every status, note
 * and callback the agents had entered.
 *
 * Both write paths now merge. It is deleted rather than left unused because an
 * exported `deleteMany({})` on the leads table is the kind of function that
 * gets wired back up by someone who only reads its name. Emptying the table on
 * purpose is a database operation — see deploy/README.md.
 */

export interface MergeLeadsResult {
  /** Rows written to the table. */
  inserted: number;
  /** Rows already present (same phone, or same name at the same address). */
  skippedExisting: number;
}

/**
 * Postgres caps a statement at 65535 bound parameters and `createMany` sends
 * one INSERT; at ~16 columns a row that is ~4000 rows. 1000 keeps a wide margin
 * and still means a 40k-row scrape is 40 statements, not 40k.
 */
const INSERT_CHUNK = 1000;

/**
 * Add scraped leads to the worklist without disturbing what is already there.
 *
 * Used by both write paths: the scraper's `POST /api/leads/ingest`, which runs
 * on a schedule and would otherwise wipe an agent's work on every run, and the
 * CSV upload, which had the same problem the second time anyone used it.
 *
 * A business already in the table is left completely untouched — including its
 * scraped fields, so neither a re-scrape nor a re-upload can overwrite an
 * address an agent has since corrected by hand.
 *
 * Duplicate matching uses `identityKeys`, the same rule `cleanLeads` applies
 * within a single file, so "already have it" means the same thing at both ends.
 *
 * Not transactional across the read and the write: two ingests running at the
 * same instant could both decide a lead is new and insert it twice. The scraper
 * pushes serially and there is no unique constraint on phone by design (see
 * schema.prisma), so this is left as-is rather than paid for with a serializable
 * transaction on every import.
 */
export async function mergeLeads(
  incoming: Lead[],
  sourceBatch: string | null,
): Promise<MergeLeadsResult> {
  // Only the three identity columns are read: pulling whole rows would mean
  // dragging every note and meeting field over the wire to answer a set
  // membership question.
  const existing = await prisma.lead.findMany({
    select: { name: true, address: true, phone: true, country: true, city: true },
  });

  const seen = new Set(existing.flatMap(identityKeys));

  /*
   * The towns already known, for reading the run-on addresses in this push.
   *
   * Most scraped addresses run the town into the street line with no comma
   * (`3909 Macleod Trail SE Calgary, AB …`), and the only safe way to find the
   * town in one is to recognise a name the data has already spelled out — see
   * `TownIndex`. Built from the rows fetched immediately above rather than from
   * a query of its own, so duplicate detection and this share one read.
   *
   * A town nobody has spelled out yet is simply not found, and that lead reads
   * "Unknown town" until it is — at which point re-running the backfill picks
   * up every earlier row that was waiting on the same name.
   */
  const towns = buildTownIndex(existing);

  const fresh: Lead[] = [];
  let skippedExisting = 0;

  for (const lead of incoming) {
    const keys = identityKeys(lead);
    if (keys.some((key) => seen.has(key))) {
      skippedExisting += 1;
      continue;
    }
    // Added as we go, so a batch containing the same business twice inserts it
    // once even when neither copy was in the table to begin with.
    for (const key of keys) seen.add(key);
    fresh.push(lead);
  }

  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    await prisma.lead.createMany({
      data: fresh
        .slice(i, i + INSERT_CHUNK)
        .map((lead) => toCreateData(lead, sourceBatch, towns)),
    });
  }

  return { inserted: fresh.length, skippedExisting };
}

/** Runtime guard for the `status` field arriving over the wire. */
function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === "string" && (CALL_STATUSES as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` and nothing else — this string reaches a date column. */
function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 24-hour `HH:MM`, matching what the meeting time input produces. */
function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export class LeadEditError extends Error {}

/**
 * Validate a PATCH body into the subset of fields an agent may edit.
 *
 * Deliberately strict rather than forgiving: a malformed date silently coerced
 * to null would look like the agent cleared a callback they had just set, and
 * they would have no way to tell. Unknown keys are ignored, which is what keeps
 * the scraped fields read-only from this endpoint.
 */
export function parseLeadEdits(body: unknown): Partial<LeadEditableFields> {
  if (typeof body !== "object" || body === null) {
    throw new LeadEditError("Expected a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const edits: Partial<LeadEditableFields> = {};

  if ("status" in input) {
    if (!isCallStatus(input.status)) {
      throw new LeadEditError(`Unknown status: ${JSON.stringify(input.status)}.`);
    }
    edits.status = input.status;
  }

  for (const key of ["notes", "meetingNotes"] as const) {
    if (key in input) {
      if (typeof input[key] !== "string") throw new LeadEditError(`${key} must be a string.`);
      edits[key] = input[key];
    }
  }

  for (const key of ["callbackDate", "meetingCompletedAt"] as const) {
    if (key in input) {
      if (input[key] !== null && !isIsoDate(input[key])) {
        throw new LeadEditError(`${key} must be YYYY-MM-DD or null.`);
      }
      edits[key] = input[key] as string | null;
    }
  }

  if ("meetingTime" in input) {
    if (input.meetingTime !== null && !isClockTime(input.meetingTime)) {
      throw new LeadEditError("meetingTime must be HH:MM or null.");
    }
    edits.meetingTime = input.meetingTime as string | null;
  }

  if ("meetingAttendees" in input) {
    if (input.meetingAttendees !== null && typeof input.meetingAttendees !== "string") {
      throw new LeadEditError("meetingAttendees must be a string or null.");
    }
    edits.meetingAttendees = input.meetingAttendees as string | null;
  }

  return edits;
}
