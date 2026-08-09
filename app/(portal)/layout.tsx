import { connection } from "next/server";

import AppShell from "@/components/AppShell";
import { PortalStatsProvider } from "@/components/PortalStatsProvider";
import { requireUser } from "@/lib/authz";
import { leadStats } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";

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
  const stats = await leadStats(today);

  return (
    // One set of counts for the shell. Whichever screen learns a fresher set
    // replaces them, so the bar keeps moving as an agent works.
    <PortalStatsProvider initialStats={stats}>
      <AppShell today={today} user={user}>
        {children}
      </AppShell>
    </PortalStatsProvider>
  );
}
