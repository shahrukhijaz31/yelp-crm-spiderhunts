import AccessDenied from "@/components/AccessDenied";
import ImportPanel from "@/components/ImportPanel";
import { requireRole } from "@/lib/authz";
import { countLeads } from "@/lib/leadDb";

/**
 * Upload CSV — ADMIN only.
 *
 * The guard is here, in the server component, rather than only in the nav bar
 * or the proxy: this is the layer that decides whether the panel is rendered
 * at all, so an agent who types the URL gets the refusal screen and never the
 * markup behind it. It runs *before* the count below, so a refused agent costs
 * a session lookup and nothing else.
 *
 * This screen used to mount the whole lead table. It never looked at a lead:
 * the only thing it drew from the set was `leads.length`, under the drop
 * target, so a workspace of several thousand rows was read, serialised and
 * parsed to print one number. That number is a `count(*)`, and the panel keeps
 * it up to date from what the upload route reports back.
 */
export default async function ImportPage() {
  const { allowed } = await requireRole("ADMIN", "/import");
  if (!allowed) return <AccessDenied />;

  const total = await countLeads();

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ImportPanel initialTotal={total} />
    </main>
  );
}
