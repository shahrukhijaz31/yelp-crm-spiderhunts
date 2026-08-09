import AccessDenied from "@/components/AccessDenied";
import { LeadsProvider } from "@/components/LeadsProvider";
import ReportsPanel from "@/components/ReportsPanel";
import { requireRole } from "@/lib/authz";
import { listLeads } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";

/**
 * Reports — ADMIN only.
 *
 * The guard is here, in the server component, rather than only in the nav bar
 * or the proxy: this is the layer that decides whether the panel is rendered
 * at all, so an agent who types the URL gets the refusal screen and never the
 * markup behind it. It runs *before* `listLeads()` below, so a refused agent
 * costs a session lookup and not a full table read.
 *
 * The lead set is loaded here rather than by the layout, which stopped reading
 * leads when the worklist was paginated. Reports aggregates across the whole
 * set by definition, so this is one of the screens that still asks for it.
 */
export default async function ReportsPage() {
  const { allowed } = await requireRole("ADMIN", "/reports");
  if (!allowed) return <AccessDenied />;

  const today = todayIso();
  const leads = await listLeads();

  return (
    <LeadsProvider initialLeads={leads} serverToday={today}>
      <main className="mx-auto w-full max-w-[1760px] flex-1 px-4 py-8 sm:px-7">
        <ReportsPanel />
      </main>
    </LeadsProvider>
  );
}
