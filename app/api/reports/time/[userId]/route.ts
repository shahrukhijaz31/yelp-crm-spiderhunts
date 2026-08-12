import { apiAdmin } from "@/lib/authz";
import { resolveTimesheetRange } from "@/lib/activityRules";
import { employeeTimeDetail } from "@/lib/timeTracking";

/**
 * GET /api/reports/time/:userId — one employee's tracking record. ADMIN only.
 *
 * `apiAdmin()` first, as everywhere under `/api/reports`. The id in the path is
 * a *filter* — which employee is being looked at — and never a claim about who
 * is looking: the caller's identity comes from the session row and is not in the
 * URL. An id that names nobody is a 404, which is why it is safe as an arbitrary
 * path segment.
 *
 * The range comes from the query string through the same resolver the timesheet
 * uses, so a period selected on one screen means the same thing on the other,
 * and an over-long custom range is clamped rather than refused.
 *
 * Screenshots appear here as a **count and a latest-capture time**. The images
 * themselves stay behind the existing viewer (`/screenshots`, `/api/screenshots`
 * and the image stream), which is already admin-only and already handles
 * authorization, storage keys and streaming. Duplicating any of that here would
 * mean two places that decide who may see a screenshot, and the second one would
 * be the one that gets it wrong.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { userId } = await params;
  const range = resolveTimesheetRange(new URL(request.url).searchParams);

  try {
    const payload = await employeeTimeDetail(userId, range);
    if (!payload) {
      return Response.json(
        { error: "not_found", message: "No such employee." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error(`GET /api/reports/time/${userId} failed:`, error);
    return Response.json(
      { error: "server_error", message: "Could not load that employee. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
