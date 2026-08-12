import { connection } from "next/server";

import TimeTrackingPanel from "@/components/TimeTrackingPanel";
import { requireUser } from "@/lib/authz";
import { resolveRange } from "@/lib/performanceRules";
import { agentTimeTracking } from "@/lib/timeTracking";

/**
 * Time tracking — every signed-in user, their own record only.
 *
 * Not an admin page and deliberately not listed in `ADMIN_PREFIXES`, for exactly
 * the reason `/my-performance` is not: this is a person's own tracked time,
 * which every role is entitled to see and no role may see for anybody else. What
 * makes that safe is not the path but the query — `agentTimeTracking` is called
 * with `user.id` from the session row and with nothing from the request, so
 * there is no URL, parameter or header that turns this into a colleague's page.
 *
 * The administrator's view of the same data is `/reports/time`: a different
 * screen, a different endpoint, admin-only at both ends.
 *
 * `connection()` for the reason the portal layout calls it — these are live
 * figures relative to "now", and a cached render of them would be a report of
 * whenever the build happened.
 */
export default async function TimeTrackingPage() {
  await connection();

  const user = await requireUser("/time-tracking");
  const tracking = await agentTimeTracking(
    user.id,
    resolveRange("today"),
    resolveRange("last7"),
  );

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <TimeTrackingPanel tracking={tracking} name={user.name} />
    </main>
  );
}
