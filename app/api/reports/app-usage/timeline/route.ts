import { appUsageTimeline } from "@/lib/appUsage";
import { resolveAppUsageFilters, resolveAppUsageRange } from "@/lib/appUsageRules";
import { apiAdmin } from "@/lib/authz";

/**
 * GET /api/reports/app-usage/timeline?agent=… — one agent's day, segment by
 * segment. ADMIN only, and optional: nothing in the feature depends on it.
 *
 * `apiAdmin()` first, as everywhere under `/api/reports`. The agent id in the
 * query string is a *filter* — which employee is being looked at — and never a
 * claim about who is looking: the caller's identity comes from the session row.
 * An id that names nobody is a 404.
 *
 * **One agent, required.** A timeline across a team is not something anybody
 * reads, and it is the one query shape in this feature that returns a row per
 * segment rather than an aggregate — so it is narrowed to one person and capped
 * (`lib/appUsage.ts`), and the payload says when it was truncated rather than
 * showing a partial day as a whole one.
 *
 * **Application labels only.** There is no window title, URL or document name in
 * `app_usage` to return; see the note on the model in `schema.prisma`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;
  const filters = resolveAppUsageFilters(params);

  if (!filters.userId) {
    return Response.json(
      { error: "agent_required", message: "Choose an employee to see a timeline." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const payload = await appUsageTimeline(
      filters.userId,
      resolveAppUsageRange(params),
      filters,
    );

    if (!payload) {
      return Response.json(
        { error: "not_found", message: "No such employee." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("GET /api/reports/app-usage/timeline failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load that timeline. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
