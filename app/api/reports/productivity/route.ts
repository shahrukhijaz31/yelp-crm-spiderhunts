import { resolveTimesheetRange } from "@/lib/activityRules";
import { apiAdmin } from "@/lib/authz";
import { teamProductivity } from "@/lib/productivity";
import { resolveProductivityFilters } from "@/lib/productivityRules";

/**
 * GET /api/reports/productivity — the team productivity dashboard. ADMIN only.
 *
 * ---------------------------------------------------------------------------
 * Who may call this
 * ---------------------------------------------------------------------------
 * `apiAdmin()` is the first statement, before the query string is read and
 * before a single figure is computed. It resolves the caller from the session
 * row in Postgres and re-reads `role` from the database rather than from
 * anything the browser sent, so an agent with curl gets a 403 and an anonymous
 * caller a 401. The path also sits under `/api/reports`, which `lib/access.ts`
 * lists as an admin prefix, so `proxy.ts` turns an agent away at the edge as
 * well — but that is a second layer and not the one that keeps anybody out.
 *
 * There is no agent-facing productivity endpoint anywhere in this application,
 * including one that would return only the caller's own score. That is a
 * deliberate difference from `/api/performance/me` and `/api/time-tracking/me`:
 * those exist because a person is entitled to their own hours and their own
 * call counts, whereas a productivity score is an appraisal, and the brief is
 * explicit that an agent must not see their own.
 *
 * ---------------------------------------------------------------------------
 * What comes back
 * ---------------------------------------------------------------------------
 * One row per agent — never one per lead, per call or per activity interval —
 * plus the totals, the ranking and the configuration the scores were calculated
 * with. Administrators are absent from it by construction: every aggregate
 * behind this filters `users.role = 'AGENT'` in SQL.
 *
 * The window comes from the same resolver the timesheet uses, so "this week" on
 * one admin screen means the same days as on the other, and an over-long custom
 * range is clamped rather than refused.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;

  try {
    const payload = await teamProductivity(
      resolveTimesheetRange(params),
      resolveProductivityFilters(params),
    );

    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("GET /api/reports/productivity failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load productivity. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
