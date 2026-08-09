import { identityKeys } from "./cleanLeads";
import { weekBounds, type CategoryOption } from "./filters";
import { Prisma } from "./generated/prisma/client";
import { fromIsoDate, toCreateData, toLead } from "./leadMapping";
import type { LeadPageMeta, LeadPageQuery } from "./leadQuery";
import { normalisePhone, type LeadStats } from "./leadUtils";
import { prisma } from "./prisma";
import { CALL_STATUSES, type CallStatus, type Lead, type LeadEditableFields } from "./types";

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
 * **This reads the whole table.** It is still the right call for the screens
 * that genuinely operate on all of it — Export writes every matching row to a
 * file, Meetings derives its agenda from the lead set, Reports aggregates it —
 * and those routes ask for it explicitly. The worklist does not: it goes
 * through {@link listLeadsPage} instead, so an agent opening the call list
 * downloads twenty rows rather than several thousand.
 */
export async function listLeads(): Promise<Lead[]> {
  const rows = await prisma.lead.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toLead);
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
  const { view, filters, today } = query;
  const clauses: Prisma.Sql[] = [];

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

  // --- category: a lead matches if it has *any* of them (`&&` is overlap) ---
  if (filters.categories.length > 0) {
    clauses.push(
      Prisma.sql`l.categories && ARRAY[${Prisma.join(filters.categories)}]::text[]`,
    );
  }

  // --- rating: an unrated lead cannot satisfy a bound, and NULL >= 3 is NULL,
  //     so Postgres drops it for free — same rule as `matchesRating`. ---
  if (filters.ratingMin !== null) {
    clauses.push(Prisma.sql`l.rating >= ${filters.ratingMin}`);
  }
  if (filters.ratingMax !== null) {
    clauses.push(Prisma.sql`l.rating <= ${filters.ratingMax}`);
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

  // --- free text ---
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
 * Ordering matches {@link listLeads} exactly. It has to: an `OFFSET` into an
 * unstable order shows some leads twice and hides others entirely.
 */
export async function listLeadsPage(query: LeadPageQuery): Promise<LeadPageResult> {
  const where = leadFilterSql(query);
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
            ORDER BY l.created_at ASC, l.id ASC
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

  // One transaction, so the five figures describe the same instant. A status
  // total that had counted a lead the callback totals had not would show up as
  // a stat bar that does not add up.
  const [groups, total, callbackDueToday, callbackOverdue, missingWebsite] =
    await prisma.$transaction([
      // Raw rather than `groupBy` only because `groupBy`'s inferred result type
      // is widened past usefulness by `$transaction`'s tuple; the statement is
      // the one `groupBy` would have written.
      prisma.$queryRaw<{ status: CallStatus; count: number }[]>(
        Prisma.sql`SELECT status::text AS status, count(*)::int AS count FROM leads GROUP BY status`,
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

  // `isCalled` is "anything but not_called", so the not-called count *is* the
  // uncalled total and there is nothing to add up.
  const notCalled = byStatus.not_called;

  return {
    total,
    called: total - notCalled,
    notCalled,
    byStatus,
    callbackDueToday,
    callbackOverdue,
    missingWebsite,
  };
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

/** Apply an agent's inline edit. Returns the saved row, or null if it is gone. */
export async function updateLeadFields(
  id: string,
  changes: Partial<LeadEditableFields>,
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

  return toLead(await prisma.lead.update({ where: { id }, data }));
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
    select: { name: true, address: true, phone: true },
  });

  const seen = new Set(existing.flatMap(identityKeys));

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
      data: fresh.slice(i, i + INSERT_CHUNK).map((lead) => toCreateData(lead, sourceBatch)),
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
