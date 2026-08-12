import { apiAdmin } from "@/lib/authz";
import { resolveRange } from "@/lib/performanceRules";
import { teamTimeTracking } from "@/lib/timeTracking";

/**
 * GET /api/reports/time — the live employee monitoring dashboard. ADMIN only.
 *
 * `apiAdmin()` resolves the caller from the session row in Postgres and re-reads
 * `role` from the database rather than from anything the browser sent, before a
 * single figure is computed. The path also sits under `/api/reports`, which
 * `lib/access.ts` lists as an admin prefix, so the policy is written in the same
 * file as the policy for the screen it serves.
 *
 * **Fixed windows, no date filter.** "Who is working right now", "today" and
 * "this week" are a fixed question with fixed answers — the same decision
 * `AgentWorkTime` documents. A range control here would let the column headings
 * lie ("today" showing last Tuesday). The range-driven view is
 * `/api/reports/timesheets` and `/api/reports/time-summary`.
 *
 * Every value comes from Postgres. There is no sample data, no placeholder and
 * no estimate anywhere in the payload: an employee with no Monitor connected
 * reports a null activity percentage, which the screen renders as "no data"
 * rather than as 0%.
 */
export async function GET(): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  try {
    const payload = await teamTimeTracking(resolveRange("today"), resolveRange("last7"));

    return Response.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("GET /api/reports/time failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load the dashboard. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
