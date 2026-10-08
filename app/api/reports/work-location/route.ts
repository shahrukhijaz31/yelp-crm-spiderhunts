import { apiAdmin } from "@/lib/authz";
import { todayWorkday } from "@/lib/performanceRules";
import { dailyLocationTotals } from "@/lib/workLocation";
import { LOCATION_DAY_OPTIONS } from "@/lib/workLocationRules";

/**
 * GET /api/reports/work-location?days=7&agent=<id> — office and remote time per
 * working day, for the Timesheets day gauges.
 *
 * Administrators only (`/api/reports` is an admin prefix, and `apiAdmin` is
 * what an agent with curl meets). `days` is one of a closed set; `agent` is a
 * user id or absent for everybody tracked, added together. Separate from
 * `/api/reports/timesheets` because the gauges have filters of their own.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;
  const requested = Number(params.get("days"));
  const days = (LOCATION_DAY_OPTIONS as readonly number[]).includes(requested)
    ? requested
    : LOCATION_DAY_OPTIONS[0];
  const rawAgent = params.get("agent");
  const userId = rawAgent && /^[a-z0-9]{1,64}$/i.test(rawAgent) ? rawAgent : null;

  try {
    const totals = await dailyLocationTotals(todayWorkday(), days, userId);
    return Response.json(
      { days: totals },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("GET /api/reports/work-location failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load office and remote time." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
