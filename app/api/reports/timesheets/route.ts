import { resolveTimesheetRange } from "@/lib/activityRules";
import { apiAdmin } from "@/lib/authz";
import { timeReport, timesheet } from "@/lib/timeTracking";

/**
 * GET /api/reports/timesheets — the timesheet and the report behind it.
 * ADMIN only.
 *
 * One endpoint for two tables because they are one screen and must agree with
 * each other: the per-employee totals and the day-by-day rows are computed from
 * the same resolved range in the same request, so a total that does not match
 * the days beneath it is not a state this can reach. The same reasoning
 * `screenshotPage` gives for returning its four reads together.
 *
 * ---------------------------------------------------------------------------
 * The filters
 * ---------------------------------------------------------------------------
 *   `range` / `from` / `to`   the period — daily, weekly, monthly or custom,
 *                             clamped to `MAX_TIMESHEET_DAYS`
 *   `agent`                   one employee, or everybody
 *   `minActivity`             keep employees at or above an activity percentage
 *
 * Every one is a *filter* on a read that `apiAdmin()` has already authorized.
 * None decides whether the caller may see anything, which is why they are safe
 * as arbitrary strings and are clamped rather than rejected.
 *
 * The activity filter applies to the summary table only.
 *
 * There was a `status` filter here too — working / inactive / offline, as of
 * the moment the request was served. It is gone, for the reason the timesheet
 * table never had one: a report over a past period that is narrowed by who
 * happens to be at their desk right now has contents that change depending on
 * when it was opened, which is not a thing anybody can sign. The presence it
 * described is live, and lives on the Time Tracking dashboard, which is about
 * right now and can therefore say it honestly.
 *
 * ---------------------------------------------------------------------------
 * Aggregation is server-side, and structurally so
 * ---------------------------------------------------------------------------
 * Neither query returns a row per activity interval. The summary is one row per
 * employee and the timesheet is one row per employee per worked day, both
 * produced by `sum`/`count` in Postgres over indexed ranges. There is no shape
 * of request that makes this stream raw activity to a browser.
 */

/** `?minActivity=40` as a percentage, or null. Out-of-range values are ignored. */
function readMinActivity(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value);
}

/** A cuid, or nothing. A filter, never a permission — see `safeId` next door. */
function safeId(raw: string | null): string | null {
  if (!raw || raw === "all") return null;
  return /^[a-z0-9]{1,64}$/i.test(raw) ? raw : null;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;
  const range = resolveTimesheetRange(params);
  const userId = safeId(params.get("agent"));

  try {
    const [report, rows] = await Promise.all([
      timeReport(range, {
        userId,
        minActivity: readMinActivity(params.get("minActivity")),
      }),
      timesheet(range, userId),
    ]);

    return Response.json(
      {
        range: { key: range.key, from: range.fromDay, to: range.toDay, label: range.label },
        report,
        timesheet: rows,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("GET /api/reports/timesheets failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not build the timesheet. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
