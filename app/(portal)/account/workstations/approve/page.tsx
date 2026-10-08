import type { Metadata } from "next";

import ApproveWorkstationPanel from "@/components/ApproveWorkstationPanel";
import { requireUser } from "@/lib/authz";
import { describePairing } from "@/lib/monitorPairing";

export const metadata: Metadata = {
  title: "Connect a workstation — SpiderHunts Leads Portal",
};

/**
 * "Connect DESKTOP-7F3K?" — where the Monitor sends an agent's browser.
 *
 * The page the whole pairing flow exists for, and the only place a pending
 * request becomes somebody's workstation. It is behind `requireUser`, which is
 * load-bearing rather than routine: an agent who is not signed in meets the
 * login form, comes back through `callbackUrl` with the `?request=` intact
 * (`safeCallbackUrl` returns the path and its query untouched), and approves
 * then. There is no version of this page that works without a session.
 *
 * The request is described here on the server, and the four states it can be
 * in are four different sentences. The one that matters most is "connected":
 * an agent who approves and then reloads the page — or follows the link in the
 * email afterwards — needs to be told it worked, not that nothing is waiting.
 * Unknown and expired stay collapsed into one answer, because there is no
 * reason for this page to confirm that a stranger's request ever existed.
 *
 * What crosses to the client is what the workstation said about itself when it
 * asked: a name, a platform, a version and two instants. No user id, because a
 * pending pairing has none; no device code, because the browser must never see
 * the workstation's half.
 */
export default async function ApproveWorkstationPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const { request } = await searchParams;
  await requireUser(
    `/account/workstations/approve${request ? `?request=${encodeURIComponent(request)}` : ""}`,
  );

  const pairing = await describePairing(request ?? "");

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ApproveWorkstationPanel view={pairing} />
    </main>
  );
}
