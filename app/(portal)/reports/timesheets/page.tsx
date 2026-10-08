import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import TimesheetsPanel from "@/components/TimesheetsPanel";
import { resolveTimesheetRange } from "@/lib/activityRules";
import { requireRole } from "@/lib/authz";
import { timeReport, timesheet } from "@/lib/timeTracking";
import { todayWorkday } from "@/lib/performanceRules";
import { dailyLocationTotals, teamLocationTotals } from "@/lib/workLocation";
import { LOCATION_DAY_OPTIONS, isLocationTracked } from "@/lib/workLocationRules";
import { listUsers } from "@/lib/userDb";

/**
 * Timesheets — ADMIN only.
 *
 * The guard is the first statement, before any hours are read. `/reports` is an
 * admin prefix, so the nav hides this and the proxy turns an agent away at the
 * edge, but this line and `apiAdmin()` on `/api/reports/timesheets` are what
 * actually refuse them.
 *
 * The default period is rendered on the server so the screen paints with real
 * rows; the panel recognises the payload it was handed and does not re-request
 * it. Changing a filter is one bounded fetch that returns aggregates only.
 */
export default async function TimesheetsPage() {
  const { allowed } = await requireRole("ADMIN", "/reports/timesheets");
  if (!allowed) return <AccessDenied />;

  await connection();

  // The default view: this week, everybody, no activity or status filter.
  const range = resolveTimesheetRange(new URLSearchParams({ range: "last7" }));
  const filters = { userId: null, minActivity: null, status: null };

  const [report, rows, users, locations] = await Promise.all([
    timeReport(range, filters),
    timesheet(range, null),
    listUsers(),
    teamLocationTotals(range, null),
  ]);

  // The office/remote gauges show one person at a time; they open on the first
  // tracked person in the list the employee picker offers.
  const tracked = users.filter((user) => isLocationTracked(user.role));
  const locationDays = tracked[0]
    ? await dailyLocationTotals(todayWorkday(), LOCATION_DAY_OPTIONS[0], tracked[0].id)
    : [];

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <TimesheetsPanel
        initialPayload={{
          range: { key: range.key, from: range.fromDay, to: range.toDay, label: range.label },
          report,
          timesheet: rows,
          locations,
        }}
        initialLocationDays={locationDays}
        // Names and roles only. The picker needs enough to label a filter and
        // nothing more, so no email address or account state travels to a screen
        // that has no use for one.
        agents={users.map((user) => ({ id: user.id, name: user.name, role: user.role }))}
      />
    </main>
  );
}
