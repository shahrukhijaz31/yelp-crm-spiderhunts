import { apiUser } from "@/lib/authz";
import { leadCategories, leadStats, listLeadsPage } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";
import { parseLeadSearchParams } from "@/lib/leadQuery";

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
 *   categories  only when `?categories=1`, because the list changes with an
 *               import and not with a keystroke
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
export async function GET(request: Request): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  // Every value is validated against a closed set here, before it reaches a
  // query — including `pageSize`, so this cannot be talked into returning the
  // whole table by asking nicely.
  const query = parseLeadSearchParams(url.searchParams, todayIso());
  const wantCategories = url.searchParams.get("categories") === "1";
  const wantRows = url.searchParams.get("rows") !== "0";

  try {
    const [page, stats, categories] = await Promise.all([
      wantRows ? listLeadsPage(query) : Promise.resolve(null),
      leadStats(query.today),
      wantCategories ? leadCategories() : Promise.resolve(null),
    ]);

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
