import { apiUser } from "@/lib/authz";
import { personalPerformanceSummary } from "@/lib/performance";
import { getActiveWorkSession } from "@/lib/workSessions";

/**
 * GET /api/performance/me — the caller's own numbers, and nobody else's.
 *
 * **The security property is structural, not a check.** This route accepts no
 * parameters at all: there is no `?userId=`, no body, and no header that
 * contributes to the query. The only id that reaches Postgres is `auth.id`,
 * which came from the session row. An agent cannot ask this endpoint about
 * another agent because the endpoint has no way to be asked — there is nothing
 * to tamper with, so there is nothing to validate and nothing to get wrong.
 *
 * That is deliberately a different shape from `/api/reports/team`, which does
 * take an agent filter and is therefore behind `apiAdmin()`. Two endpoints
 * rather than one with a role branch inside it: the branch is the bug, and
 * separating them means the agent-reachable code path never contains a query
 * that *could* return somebody else's row.
 *
 * Open to both roles. An administrator has their own day too, and seeing it
 * tells them nothing they are not already entitled to.
 */
export async function GET(): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  try {
    const [performance, session] = await Promise.all([
      personalPerformanceSummary(auth.id),
      // Returned alongside so the "active time" figure and the running clock
      // beside it are read in one request and cannot disagree.
      getActiveWorkSession(auth.id),
    ]);

    return Response.json(
      { performance, session },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("GET /api/performance/me failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not load your performance figures.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
