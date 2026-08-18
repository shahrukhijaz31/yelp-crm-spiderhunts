import { apiModule } from "@/lib/authz";
import { demoSummariesFor } from "@/lib/demoWebsites";
import { leadCategories, leadStats, leadWorkCounts, listLeadsPage } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";
import { parseLeadSearchParams } from "@/lib/leadQuery";
import { LEAD_SEARCH_LIMIT, rateLimitRefusal } from "@/lib/rateLimit";

/**
 * GET /api/leads — one page of the worklist.
 *
 * Any signed-in user, either role: the worklist is the job, and an agent
 * cannot do it without the leads. Unauthenticated callers get a 401 whether or
 * not they knew the URL — this is the endpoint that would otherwise hand the
 * whole lead database to anyone who found it.
 *
 * **This route no longer returns every lead.** It used to, and the worklist
 * kept the whole table in React state and narrowed it on each render; at ~1,700
 * rows that was a multi-megabyte payload to show twenty of them, and it grew
 * with the scraper. The tab, the filters, the page and the page size now travel
 * as query parameters (see `lib/leadQuery.ts` for the vocabulary and its
 * validation) and Postgres does the narrowing, so the response is bounded by
 * `pageSize` — at most 100 rows — regardless of how large the table gets.
 *
 * The response carries what the screen needs to describe itself and nothing
 * more:
 *
 *   leads       the current page's rows, in the table's stable order
 *   page        the *effective* page, which may be clamped down from the one
 *               asked for when a filter matches fewer rows than the URL expects
 *   pageSize    echoed back, since an invalid one is replaced rather than refused
 *   total       rows matching the current tab and filters — the number the
 *               pager walks, not the size of the table
 *   totalPages  derived, but sent so the client and the server cannot disagree
 *               about which page is the last one
 *   stats       workspace-wide counts (see `leadStats`) — unfiltered by design
 *   workCounts  how many leads are New and how many Called (`lib/workState.ts`),
 *               likewise unfiltered — these are the tab badges
 *   categories  only when `?categories=1`, because the list changes with an
 *               import and not with a keystroke
 *   demos       only when `?section=demo` — the demo image and link belonging
 *               to the rows on this page, keyed by lead id and **sparse**: a
 *               lead with neither is simply absent from the map. No lead field
 *               is duplicated in there; see `lib/demoWebsites.ts`.
 *
 * `?rows=0` asks for the counts alone and skips the page entirely. That is what
 * the worklist sends after an inline edit: the headline strip and the tab
 * badges have to move when a lead is marked, but re-running the list query
 * would also re-apply the filters, and a row vanishing from under the agent who
 * just saved it is not a refresh — it is losing your place.
 *
 * `count` is kept as an alias of `total` so anything still reading the old
 * field gets a number rather than `undefined` — though it now means "matching"
 * rather than "all", which `total` says more honestly.
 *
 * Not cached: an agent who changes a status expects the next read to show it.
 */
/*
 * The Leads module gate.
 *
 * `apiModule("leads")` rather than `apiUser()`: this portal now has two
 * workspaces, and an agent may be granted either, both or — for a brand-new
 * account an administrator has not finished setting up — neither. The guard is
 * the same one the Demo Websites endpoints use with the other key, and it
 * resolves role *and* module access from the `users` row in Postgres on every
 * request.
 *
 * Nothing changed for anybody who already had access. `can_access_leads`
 * defaults to TRUE and every account that existed before the module switch was
 * added kept it, so this refuses exactly the accounts an administrator has
 * deliberately taken off the worklist, and nobody else. Administrators are
 * never subject to it.
 */

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Every value is validated against a closed set here, before it reaches a
  // query — including `pageSize`, so this cannot be talked into returning the
  // whole table by asking nicely. `section` is validated the same way and is
  // the one parameter that also picks the guard, immediately below.
  const query = parseLeadSearchParams(url.searchParams, todayIso());
  const demoSection = query.section === "demo";

  /*
   * The guard, chosen by the section.
   *
   * Both sections read the same leads, so the question is not "which rows" but
   * "which screen is this person entitled to" — and the two are granted
   * separately. `?section=demo` demands the Demo Websites module; anything else
   * demands New Leads. An agent with one and not the other is refused the
   * section they were not given, whichever they ask for.
   *
   * Naming a section in a query string asks a question, it does not answer one:
   * the module is read from the `users` row in Postgres on this request, so the
   * parameter can only ever narrow what a caller is allowed, never widen it.
   */
  const auth = await apiModule(demoSection ? "demoWebsites" : "leads");
  if (auth instanceof Response) return auth;
  const wantCategories = url.searchParams.get("categories") === "1";
  const wantRows = url.searchParams.get("rows") !== "0";

  /*
   * Only a *search* is counted, and only when rows are being returned.
   *
   * The free-text term is the expensive part of this query: it is the one
   * clause that cannot use an index, because it is a `LIKE '%…%'` over four
   * concatenated columns (see `leadFilterSql`). A tab change or a page turn
   * costs an indexed read and is left alone, as is the `?rows=0` counts-only
   * request the worklist fires whenever its tab regains focus — throttling that
   * would break a refresh nobody asked for.
   *
   * The 200-character cap on the term itself is unchanged and still applied in
   * `parseLeadSearchParams`, before the value reaches SQL. This is the second
   * half of the same idea: that one bounds the cost of a single search, this
   * one bounds how many of them one account can ask for.
   *
   * Counted against the session's user id, which `apiUser()` resolved from the
   * session row in Postgres. Nothing in the request names the bucket.
   */
  if (wantRows && query.filters.query.trim() !== "") {
    const limited = await rateLimitRefusal(LEAD_SEARCH_LIMIT, auth.id);
    if (limited) return limited;
  }

  try {
    // `workCounts` rides along with `stats` — including on the `?rows=0`
    // request, so saving a call outcome moves the New and Called badges on the
    // same tick as the headline figures rather than a page load later.
    const [page, stats, workCounts, categories] = await Promise.all([
      wantRows ? listLeadsPage(query) : Promise.resolve(null),
      leadStats(query.today),
      leadWorkCounts(),
      wantCategories ? leadCategories() : Promise.resolve(null),
    ]);

    /*
     * The demo half, for the rows this page actually contains.
     *
     * Sequential rather than concurrent with the query above, and it has to be:
     * it is keyed by the ids that query just chose. Bounded by the page — at
     * most 100 primary-key lookups on a unique column — so it costs the same
     * whether the portal holds twenty leads or twenty thousand.
     *
     * Sparse on purpose. A lead with no demo row has no entry here, and the
     * screen draws it with an empty image cell and an empty link. That is what
     * makes every existing lead appear in the Demo Websites view without
     * anything having been backfilled.
     *
     * Only read for the demo section: the worklist has no use for it, and
     * fetching it there would be a query per page load for a column nobody
     * draws.
     */
    const demos =
      demoSection && page ? await demoSummariesFor(page.leads.map((lead) => lead.id)) : null;

    return Response.json(
      {
        ...(page
          ? {
              leads: page.leads,
              page: page.page,
              pageSize: page.pageSize,
              total: page.total,
              totalPages: page.totalPages,
              count: page.total,
            }
          : {}),
        stats,
        workCounts,
        ...(demos ? { demos } : {}),
        ...(categories ? { categories } : {}),
        source: "postgres",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("GET /api/leads failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message:
          "Could not reach the database. Check that Postgres is running and that DATABASE_URL in .env.local is correct.",
      },
      { status: 503 },
    );
  }
}
