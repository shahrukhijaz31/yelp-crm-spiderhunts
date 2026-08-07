import { connection } from "next/server";

import NavBar from "@/components/NavBar";
import { LeadsProvider } from "@/components/LeadsProvider";
import { requireUser } from "@/lib/authz";
import { listLeads } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";

/**
 * The authenticated portal.
 *
 * Every route inside this group is behind one `requireUser()`, and it runs
 * **before** any lead data is read. That ordering is the point: an
 * unauthenticated request is redirected while `listLeads()` is still an
 * unevaluated line below, so no lead ever reaches the wire for someone who is
 * not signed in — regardless of what the proxy did or did not catch.
 *
 * Role is not enforced here. Every signed-in user, agent or admin, gets the
 * worklist and the meetings screen; the admin-only pages guard themselves, so
 * that this layout has exactly one job and cannot be the reason an agent is
 * refused something they should have.
 */
export default async function PortalLayout({ children }: LayoutProps<"/">) {
  // Lead data is read per request, not baked at build time: the worklist is
  // live data, and callback highlighting is relative to "now".
  await connection();

  const user = await requireUser();
  const today = todayIso();
  const leads = await listLeads();

  return (
    <>
      {/* One store for every route: /import loads a CSV that / then shows. */}
      <LeadsProvider initialLeads={leads} serverToday={today}>
        <NavBar today={today} user={user} />
        {children}
      </LeadsProvider>
    </>
  );
}
