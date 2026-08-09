import AccessDenied from "@/components/AccessDenied";
import ImportPanel from "@/components/ImportPanel";
import { LeadsProvider } from "@/components/LeadsProvider";
import { requireRole } from "@/lib/authz";
import { listLeads } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";

/**
 * Upload CSV — ADMIN only.
 *
 * The guard is here, in the server component, rather than only in the nav bar
 * or the proxy: this is the layer that decides whether the panel is rendered
 * at all, so an agent who types the URL gets the refusal screen and never the
 * markup behind it. It runs *before* `listLeads()` below, so a refused agent
 * costs a session lookup and not a full table read.
 *
 * The lead set is loaded here rather than by the layout, which stopped reading
 * leads when the worklist was paginated. The panel reports what an upload
 * changed against the set as it stands, and `replaceLeads` swaps that set
 * wholesale afterwards, so it works on all of it.
 */
export default async function ImportPage() {
  const { allowed } = await requireRole("ADMIN", "/import");
  if (!allowed) return <AccessDenied />;

  const today = todayIso();
  const leads = await listLeads();

  return (
    <LeadsProvider initialLeads={leads} serverToday={today}>
      <main className="mx-auto w-full max-w-[1760px] flex-1 px-4 py-8 sm:px-7">
        <ImportPanel />
      </main>
    </LeadsProvider>
  );
}
