import { appUsageReport } from "@/lib/appUsage";
import { resolveAppUsageFilters, resolveAppUsageRange } from "@/lib/appUsageRules";
import { apiAdmin } from "@/lib/authz";

/**
 * GET /api/reports/app-usage — the application usage report. ADMIN only.
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
 * **There is no agent-facing app-usage endpoint anywhere in this application**,
 * including one that would return only the caller's own. That is deliberate and
 * matches the screenshot viewer rather than `/api/time-tracking/me`: a person is
 * entitled to their own hours, and app usage is monitoring data whose subject
 * reading it back would be a different feature.
 *
 * ---------------------------------------------------------------------------
 * What comes back
 * ---------------------------------------------------------------------------
 * Aggregates only — at most nine application rows, the totals, and (when one
 * agent is selected) that agent's tracked time and activity figure. There is no
 * query behind this that returns a row per usage segment, so a month of data
 * for a whole team is the same size on the wire as a day of it for one person.
 *
 * `agent` and `application` are *filters*: they say what is being looked at and
 * never who is looking. An agent id that names nobody reports nothing, which is
 * what makes it safe to pass through unvalidated.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;

  try {
    const payload = await appUsageReport(
      resolveAppUsageRange(params),
      resolveAppUsageFilters(params),
    );

    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("GET /api/reports/app-usage failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load app usage. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
