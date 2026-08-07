import AccessDenied from "@/components/AccessDenied";
import ImportPanel from "@/components/ImportPanel";
import { requireRole } from "@/lib/authz";

/**
 * Upload CSV — ADMIN only.
 *
 * The guard is here, in the server component, rather than only in the nav bar
 * or the proxy: this is the layer that decides whether the panel is rendered
 * at all, so an agent who types the URL gets the refusal screen and never the
 * markup behind it.
 */
export default async function ImportPage() {
  const { allowed } = await requireRole("ADMIN", "/import");
  if (!allowed) return <AccessDenied />;

  return (
    <main className="mx-auto w-full max-w-[1760px] flex-1 px-7 py-8">
      <ImportPanel />
    </main>
  );
}
