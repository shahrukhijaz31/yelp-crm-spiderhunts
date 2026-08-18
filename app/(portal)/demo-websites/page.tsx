import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import DemoWebsitesPanel from "@/components/DemoWebsitesPanel";
import { requireModule } from "@/lib/authz";
import { listDemoWebsites } from "@/lib/demoWebsites";
import { defaultDemoWebsiteQuery } from "@/lib/demoWebsiteRules";

/**
 * Demo Websites.
 *
 * The guard is the first statement, before a single row is read, so an agent
 * without the module who types this URL costs a session lookup and gets the
 * refusal screen rather than the markup — not even the *names*, which is the
 * part worth withholding.
 *
 * It is the authoritative check for the **page**. It is not the check for the
 * data: every endpoint the panel touches enforces the same rule for itself
 * (`apiModule("demoWebsites")` to read, `apiAdmin()` to write), because the two
 * are reached separately — a page guard cannot protect an API somebody calls
 * with curl, and the image route in particular is reached by the browser
 * directly as an `<img src>`.
 *
 * The first page is rendered here so the screen paints with real rows; the
 * panel recognises the query it was handed and does not re-request it. The
 * images are not server-rendered — they cannot be, they are authenticated byte
 * streams — so the table arrives complete and the thumbnails fill in as the
 * browser fetches each one.
 */
export default async function DemoWebsitesPage() {
  const { user, allowed } = await requireModule("demoWebsites", "/demo-websites");
  if (!allowed) return <AccessDenied />;

  // Per-request render: the list is live data and the default sort is
  // newest-first, so nothing here may be baked at build time.
  await connection();

  const query = defaultDemoWebsiteQuery();
  const payload = await listDemoWebsites(query);

  return (
    <DemoWebsitesPanel
      initialPayload={payload}
      initialQuery={query}
      /*
       * Whether the Add, Edit and Delete controls are drawn. Passed explicitly
       * rather than hard-coded so the component states its condition instead of
       * assuming its caller's. It is not a permission: every write endpoint
       * re-reads the caller's role from Postgres on every request and refuses
       * an agent whatever this says.
       */
      canManage={user.role === "ADMIN"}
    />
  );
}
