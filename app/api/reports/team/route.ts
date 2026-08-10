import { apiAdmin } from "@/lib/authz";
import { teamPerformance } from "@/lib/performance";
import { resolveRange } from "@/lib/performanceRules";

/**
 * GET /api/reports/team — every agent's numbers over a window. ADMIN only.
 *
 * The endpoint behind the Team Performance screen, and the one an agent must
 * never reach. Three things enforce that, and only the first two are load-
 * bearing:
 *
 *   1. `apiAdmin()` — resolves the caller from the session row in Postgres and
 *      answers 403 before a single parameter is read, let alone a query run. An
 *      agent with a valid session, curl and the URL gets the refusal.
 *   2. The path sits under `/api/reports`, which `lib/access.ts` lists as an
 *      admin prefix — so the policy naming this endpoint admin-only is written
 *      in the same file as the policy for the screen it serves, and neither can
 *      be changed without the other being read.
 *   3. The navigation does not draw the link for an agent. Tidiness, not
 *      security — removing it would change nothing about who can read this.
 *
 * The `agent` parameter is a *filter*, not a permission: it narrows an already
 * authorized read to one person. It is never consulted to decide whether the
 * caller may see anything, which is why it is safe for it to be an arbitrary
 * id from a query string — the worst a bad one can do is match no rows.
 *
 * Every figure comes back aggregated. No lead, no activity row and no session
 * row leaves this endpoint; the response is one object per agent whatever the
 * size of the tables behind it.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;
  // `resolveRange` validates and clamps: an unknown preset is "today", a
  // malformed custom date falls back, and a reversed pair is swapped. A report
  // is not a place to 400 somebody over a date picker.
  const range = resolveRange(params.get("range"), params.get("from"), params.get("to"));
  const agent = params.get("agent");
  const userId = agent && agent !== "all" ? agent : null;

  try {
    const report = await teamPerformance(range, userId);
    return Response.json({ report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/reports/team failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not load the team report.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
