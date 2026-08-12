import { cookies } from "next/headers";
import { connection } from "next/server";

import AppShell from "@/components/AppShell";
import { LeadQueueProvider } from "@/components/LeadQueueProvider";
import { PortalStatsProvider } from "@/components/PortalStatsProvider";
import { WorkSessionProvider } from "@/components/WorkSessionProvider";
import { requireUser } from "@/lib/authz";
import { leadStats, leadWorkCounts } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";
import { NAV_MODE_COOKIE, readNavMode } from "@/lib/navPreference";
import { getWorkClock } from "@/lib/workSessions";

/**
 * The authenticated portal.
 *
 * Every route inside this group is behind one `requireUser()`, and it runs
 * **before** any lead data is read. That ordering is the point: an
 * unauthenticated request is redirected while the query below is still an
 * unevaluated line, so no lead ever reaches the wire for someone who is not
 * signed in — regardless of what the proxy did or did not catch.
 *
 * Role is not enforced here. Every signed-in user, agent or admin, gets the
 * worklist and the meetings screen; the admin-only pages guard themselves, so
 * that this layout has exactly one job and cannot be the reason an agent is
 * refused something they should have.
 *
 * **This layout no longer loads the leads.** It used to call `listLeads()` and
 * seed every route with the whole table — including `/settings`, which never
 * looks at one — so the cost of the largest screen was paid on all of them. It
 * now reads only the aggregate the nav bar needs (a handful of counts, computed
 * by Postgres), and each route asks for the lead data its own job requires:
 * the worklist takes a page at a time, while Export, Meetings, Reports and
 * Import mount `LeadsProvider` themselves because they genuinely operate on the
 * whole set.
 */
export default async function PortalLayout({ children }: LayoutProps<"/">) {
  // Read per request, not baked at build time: the worklist is live data, and
  // callback highlighting is relative to "now".
  await connection();

  const user = await requireUser();
  const today = todayIso();

  /*
   * How wide the reader keeps their sidebar. A display preference and nothing
   * else: it is read only to pick a CSS class, it names nobody, and it gates
   * nothing — an unrecognised value falls back to the automatic layout rather
   * than erroring (`readNavMode`). It is read here, on the server, so the rail
   * paints at the right width on the first frame instead of snapping to it
   * after hydration.
   */
  const navMode = readNavMode((await cookies()).get(NAV_MODE_COOKIE)?.value);
  // Two aggregates, no rows: the nav bar's counters and the New/Called badges
  // in the rail. Both are `count(*)` over an indexed column, and neither
  // depends on the other, so they go together.
  // The third read is the work clock: when the open shift began, and how many
  // seconds of *finished* shifts today already amount to. It is here rather than
  // in the top bar for the same reason the counts are — the shell stays mounted
  // across navigations, so the clock is read once and keeps running as an agent
  // moves between screens instead of being re-read on each.
  //
  // Reading both from Postgres rather than starting a timer in the browser is
  // what makes the figures survive a refresh, agree between two tabs, and mean
  // the same thing as the "active time" on the admin report. It is also what
  // makes signing out and back in stop looking like a reset: the *session*
  // restarts, because it is a new session, but the day's total is a sum over
  // every session that started today and carries straight on.
  const [stats, workCounts, workClock] = await Promise.all([
    leadStats(today),
    leadWorkCounts(),
    getWorkClock(user.id),
  ]);

  return (
    // One set of counts for the shell. Whichever screen learns a fresher set
    // replaces them, so the bar keeps moving as an agent works.
    <PortalStatsProvider initialStats={stats}>
      {/* The queue lives out here because the control that changes it is in the
          sidebar and the screen that answers to it is in the route. */}
      <LeadQueueProvider initialCounts={workCounts}>
        {/* Outside the shell so the heartbeat keeps beating whatever screen is
            on, including the ones that draw no clock at all. */}
        <WorkSessionProvider initialClock={workClock}>
          <AppShell today={today} user={user} navMode={navMode}>
            {children}
          </AppShell>
        </WorkSessionProvider>
      </LeadQueueProvider>
    </PortalStatsProvider>
  );
}
