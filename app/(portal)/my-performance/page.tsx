import { connection } from "next/server";

import MyPerformancePanel from "@/components/MyPerformancePanel";
import { requireUser } from "@/lib/authz";
import { todayIso } from "@/lib/leadUtils";
import { myScreenshotPage } from "@/lib/myScreenshots";
import { defaultMyScreenshotQuery } from "@/lib/myScreenshotsRules";
import { personalPerformanceSummary } from "@/lib/performance";

/**
 * My performance — every signed-in user, their own figures only.
 *
 * Not an admin page and deliberately not listed in `ADMIN_PREFIXES`: an agent's
 * own record is theirs to see, and an administrator has a day too. What makes
 * that safe is not the path but the query — `personalPerformanceSummary` is
 * called with `user.id` from the session row and with nothing from the request,
 * so there is no URL, parameter or header that turns this into somebody else's
 * page. The team-wide view lives at `/reports/team`, is a different screen with
 * a different endpoint, and is admin-only at both ends.
 *
 * `connection()` for the same reason the portal layout calls it: these are live
 * figures relative to "now", and a cached render of them would be a report of
 * whenever the build happened.
 *
 * The first page of screenshots is fetched here too, beside the figures rather
 * than after them. Both reads are scoped by `user.id` from the session row and
 * neither takes anything from the request, so the same sentence above covers
 * both: there is no URL, parameter or header that turns this into somebody
 * else's page. Doing it here rather than on mount in the browser saves the
 * section a round trip and stops the grid appearing empty for a moment on a
 * screen the server could already answer.
 */
export default async function MyPerformancePage() {
  await connection();

  const user = await requireUser("/my-performance");
  const today = todayIso();

  const [performance, screenshots] = await Promise.all([
    personalPerformanceSummary(user.id),
    myScreenshotPage(user.id, defaultMyScreenshotQuery(today)),
  ]);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <MyPerformancePanel
        performance={performance}
        name={user.name}
        screenshots={screenshots}
        serverToday={today}
      />
    </main>
  );
}
