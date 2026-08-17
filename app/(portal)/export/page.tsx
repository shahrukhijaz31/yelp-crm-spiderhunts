import AccessDenied from "@/components/AccessDenied";
import ExportPanel from "@/components/ExportPanel";
import { LeadsProvider } from "@/components/LeadsProvider";
import TooManyRequests from "@/components/TooManyRequests";
import { requireRole } from "@/lib/authz";
import { listLeads } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";
import { consumeRateLimit, LEAD_EXPORT_LIMIT } from "@/lib/rateLimit";

/**
 * Export Data — ADMIN only.
 *
 * The guard is here, in the server component, rather than only in the nav bar
 * or the proxy: this is the layer that decides whether the panel is rendered
 * at all, so an agent who types the URL gets the refusal screen and never the
 * markup behind it. It runs *before* `listLeads()` below, so a refused agent
 * costs a session lookup and not a full table read.
 *
 * The lead set is loaded here rather than by the layout, which stopped reading
 * leads when the worklist was paginated. Export is one of the screens that
 * genuinely wants all of them: it writes every matching row to a file, and
 * "every matching row" is not a page.
 *
 * That whole-table read is also why this page is rate limited (`lib/rateLimit.ts`)
 * and the other admin screens are not. There is no export *endpoint* to limit:
 * the file is built in the browser from the rows this page hands it
 * (`lib/exportLeads.ts`), so the server-side cost of an export is exactly one
 * render of this page, and the place to bound it is here. The limit is counted
 * against the administrator's own id, after the role check — an agent who is
 * about to be refused should not be able to fill somebody else's window, and
 * they never reach `listLeads()` either way.
 */
export default async function ExportPage() {
  const { user, allowed } = await requireRole("ADMIN", "/export");
  if (!allowed) return <AccessDenied />;

  const verdict = await consumeRateLimit(LEAD_EXPORT_LIMIT, user.id);
  if (!verdict.allowed) return <TooManyRequests />;

  const today = todayIso();
  const leads = await listLeads();

  return (
    <LeadsProvider initialLeads={leads} serverToday={today}>
      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
        <ExportPanel />
      </main>
    </LeadsProvider>
  );
}
