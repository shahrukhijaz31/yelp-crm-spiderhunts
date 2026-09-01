import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import TeamPerformancePanel from "@/components/TeamPerformancePanel";
import { requireRole } from "@/lib/authz";
import { teamPerformance } from "@/lib/performance";
import { resolveRange } from "@/lib/performanceRules";
import { listUsers } from "@/lib/userDb";

/**
 * Team performance — ADMIN only.
 *
 * The guard is the first statement, before any aggregate is read, so an agent
 * who types this URL costs a session lookup and gets the refusal screen rather
 * than the markup. It is the authoritative check: `canAccess` hiding the nav
 * item and `/reports` being listed in `ADMIN_PREFIXES` are both about tidiness
 * and policy documentation, and removing either would change nothing here.
 *
 * The same refusal is enforced independently on the endpoint the panel refetches
 * from (`/api/reports/team`, behind `apiAdmin()`), because the two are reached
 * separately: a page guard cannot protect an API an agent calls with curl.
 *
 * The report is rendered on the server for the default window, so the screen
 * paints with real figures instead of a spinner; the panel recognises the
 * report it was handed and does not re-request it.
 */
export default async function TeamPerformancePage() {
  const { allowed } = await requireRole("ADMIN", "/reports/team");
  if (!allowed) return <AccessDenied />;

  // Live figures relative to "now" — see the portal layout for why this is not
  // allowed to be a build-time render.
  await connection();

  // The shift window, not the calendar day: half this team works an evening
  // shift that ends after midnight, and "Today" reports such a shift as two
  // part-days on two dates. See `SHIFT_WINDOW_HOURS`.
  const range = resolveRange("last10h");
  const [report, users] = await Promise.all([teamPerformance(range), listUsers()]);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <TeamPerformancePanel
        initialReport={report}
        // Names and roles only. The picker needs enough to label a filter and
        // nothing more, so no email address or account state travels to a
        // screen that has no use for one.
        agents={users.map((user) => ({ id: user.id, name: user.name, role: user.role }))}
      />
    </main>
  );
}
