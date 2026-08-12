import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import ScreenshotsPanel from "@/components/ScreenshotsPanel";
import { requireRole } from "@/lib/authz";
import { todayIso } from "@/lib/leadUtils";
import { screenshotPage } from "@/lib/screenshotViewer";
import { defaultScreenshotQuery } from "@/lib/screenshotViewerRules";
import { listUsers } from "@/lib/userDb";

/**
 * Screenshots — ADMIN only.
 *
 * The guard is the first statement, before a single screenshot row is read, so
 * an agent who types this URL costs a session lookup and gets the refusal
 * screen rather than the markup. It is the authoritative check for the *page*:
 * `canAccess` hiding the nav item and `/screenshots` being listed in
 * `ADMIN_PREFIXES` are about tidiness and policy documentation, and removing
 * either would change nothing here.
 *
 * The same refusal is enforced independently on every endpoint the panel uses —
 * the list, the metadata and the image stream, and the two deletes at
 * `/api/admin/screenshots`, each behind `apiAdmin()` — because the two are
 * reached separately: a page guard cannot protect an API an agent calls with
 * curl, and the image route in particular is reached by the browser directly as
 * an `<img src>`.
 *
 * Today's screenshots are rendered on the server for the default filter, so the
 * screen paints with real cards instead of a skeleton; the panel recognises the
 * payload it was handed and does not re-request it. The images themselves are
 * not server-rendered — they cannot be, they are authenticated byte streams —
 * so the grid arrives complete and fills in as the browser fetches each one.
 */
export default async function ScreenshotsPage() {
  const { user, allowed } = await requireRole("ADMIN", "/screenshots");
  if (!allowed) return <AccessDenied />;

  // "Today" and "the latest capture" are relative to now, so this must be a
  // per-request render rather than anything baked at build time — the same
  // reason the portal layout calls it.
  await connection();

  const today = todayIso();
  const query = defaultScreenshotQuery(today);

  const [payload, users] = await Promise.all([screenshotPage(query), listUsers()]);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ScreenshotsPanel
        initialPayload={payload}
        serverToday={today}
        // Names and roles only. The picker needs enough to label a filter and
        // nothing more, so no email address or account state travels to a
        // screen that has no use for one.
        agents={users.map((account) => ({
          id: account.id,
          name: account.name,
          role: account.role,
        }))}
        /*
         * Whether the delete controls are drawn. Always true past the guard
         * above, and passed explicitly rather than hard-coded so the component
         * states its condition instead of assuming its caller's. It is not a
         * permission: `DELETE /api/admin/screenshots…` re-reads the caller's
         * role from Postgres on every request and refuses an agent whatever
         * this says.
         */
        canDelete={user.role === "ADMIN"}
      />
    </main>
  );
}
