import type { Metadata } from "next";

import MyWorkstationsPanel from "@/components/MyWorkstationsPanel";
import { requireUser } from "@/lib/authz";
import { listWorkstationsFor } from "@/lib/workstations";

export const metadata: Metadata = {
  title: "Your workstations — SpiderHunts Leads Portal",
};

/**
 * The computers running SpiderHunts Monitor against your account, and the
 * button that disconnects one.
 *
 * Every role may open it and it only ever shows your own machines: the list is
 * read here, on the server, from the session's own user id, so there is no id
 * in the URL and no endpoint that could be asked about somebody else. That is
 * the `/downloads` pattern, and it is why this feature has no
 * `GET /api/account/workstations` at all.
 *
 * An administrator sees an empty list, truthfully — `MONITOR_ROLES` admits
 * agents and contributors, so an administrator cannot have connected one. The
 * menu entry is hidden for them rather than the page being refused, because
 * "you have none" is the honest answer and a 403 would imply otherwise.
 *
 * `requireUser` repeats what the portal layout already does, as every page here
 * does, so nobody has to read the layout to know who may open this.
 */
export default async function WorkstationsPage() {
  const user = await requireUser("/account/workstations");
  const workstations = await listWorkstationsFor(user.id);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <MyWorkstationsPanel workstations={workstations} />
    </main>
  );
}
