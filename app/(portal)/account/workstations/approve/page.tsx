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
 * The request is described here on the server. `describePairing` returns null
 * for unknown, expired and already-handled alike — a page that told those
 * apart would turn the request id into a way of asking whether somebody else's
 * pairing exists — and the panel renders the same "nothing to connect" state
 * for all of them.
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

  const pairing = request ? await describePairing(request) : null;

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ApproveWorkstationPanel request={pairing} />
    </main>
  );
}
