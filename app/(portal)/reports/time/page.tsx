import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import TimeDashboardPanel from "@/components/TimeDashboardPanel";
import { requireRole } from "@/lib/authz";
import { resolveRange } from "@/lib/performanceRules";
import { teamTimeTracking } from "@/lib/timeTracking";

/**
 * Time tracking dashboard — ADMIN only.
 *
 * The guard is the first statement, before a single figure is read, so an agent
 * who types this URL costs a session lookup and gets the refusal screen rather
 * than the markup. `/reports` is already an admin prefix in `lib/access.ts`, so
 * `canAccess` hides the nav item and `proxy.ts` turns the request away at the
 * edge — but neither is what keeps anybody out. This is, and `apiAdmin()` on the
 * endpoint behind it is, and the two are reached separately: a page guard cannot
 * protect an API an agent calls with curl.
 *
 * The board is rendered on the server for its first paint and then refreshes
 * itself on a timer, so it opens with real figures instead of a skeleton.
 */
export default async function TimeDashboardPage() {
  const { allowed } = await requireRole("ADMIN", "/reports/time");
  if (!allowed) return <AccessDenied />;

  // "Right now", "today" and "this week" are all relative to the request, so
  // this must be a per-request render rather than anything baked at build time.
  await connection();

  const payload = await teamTimeTracking(resolveRange("today"), resolveRange("last7"));

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <TimeDashboardPanel initialPayload={payload} />
    </main>
  );
}
