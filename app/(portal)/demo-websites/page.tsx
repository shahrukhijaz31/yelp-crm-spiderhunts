import AccessDenied from "@/components/AccessDenied";
import Worklist from "@/components/Worklist";
import { requireModule } from "@/lib/authz";
import { demoFilterCounts, demoSummariesFor } from "@/lib/demoWebsites";
import { EMPTY_FILTERS } from "@/lib/filters";
import { leadCategories, leadLocations, listLeadsPage } from "@/lib/leadDb";
import { DEFAULT_SORT, readPage, readPageSize } from "@/lib/leadQuery";
import { todayIso } from "@/lib/leadUtils";
import { DEFAULT_WORK_STATE } from "@/lib/workState";

/**
 * Demo Websites — **the worklist, in demo mode**.
 *
 * This route reads `leads`. It is byte-for-byte the same query the worklist at
 * `/` makes, through the same `listLeadsPage`, with the same defaults, and it
 * renders the same `Worklist` component. That is the whole architecture: there
 * is no demo lead pool, no copy of a lead anywhere, and no second dataset to
 * keep in step. A lead whose status or notes were changed on the worklist five
 * seconds ago shows the new values here, because there is only one row.
 *
 * The two differences, and they are the only two:
 *
 *   `section="demo"`   the table swaps the Audio column for Demo image and
 *                      Demo link, and the lead window draws the demo panel
 *                      instead of the call recording. No audio control is
 *                      rendered anywhere in this view.
 *   `initialDemos`     the demo image and link belonging to the leads on *this
 *                      page*, keyed by lead id and sparse — a lead with neither
 *                      simply is not in the map, and is drawn with an empty
 *                      image cell and "Add link".
 *
 * That sparseness is what makes the twenty thousand leads that predate this
 * feature appear here from the moment it ships: nothing was backfilled, and a
 * lead needs no `demo_websites` row to be listed.
 *
 * The guard is the first statement, before a single lead is read, so an agent
 * without the module who types this URL costs a session lookup and gets the
 * refusal screen rather than the markup. It is the authoritative check for the
 * *page*, not for the data: `GET /api/leads?section=demo` demands the same
 * module for itself, because a page guard cannot protect an API somebody calls
 * with curl.
 */
export default async function DemoWebsitesPage(props: PageProps<"/demo-websites">) {
  const { access, allowed } = await requireModule("demoWebsites", "/demo-websites");
  if (!allowed) {
    // Somebody refused here may still have the worklist, which is where their
    // way out should point. An account with neither module gets the default.
    return access.leads ? <AccessDenied /> : <AccessDenied homeHref="/" homeLabel="Back to the portal" />;
  }

  const params = await props.searchParams;
  const today = todayIso();

  // The same first page the worklist renders, under the same defaults — the
  // queue an agent lands on, no view filter, no sort, page one. `Worklist`
  // recognises the page it was handed and does not re-request it.
  const result = await listLeadsPage({
    section: "demo",
    workState: DEFAULT_WORK_STATE,
    view: "all",
    filters: EMPTY_FILTERS,
    sort: DEFAULT_SORT,
    today,
    page: readPage(one(params.page)),
    pageSize: readPageSize(one(params.pageSize)),
  });

  // Reads that depend on the page above, and reads that do not. The demo
  // metadata is keyed by the ids `listLeadsPage` just chose, so it cannot start
  // until that has answered; the filter panel's category and location lists are
  // independent and ride along.
  const [demos, categories, locations, demoCounts] = await Promise.all([
    demoSummariesFor(result.leads.map((lead) => lead.id)),
    leadCategories(),
    leadLocations(),
    // The numbers on the demo filter buttons, so the panel opens with them
    // rather than filling in after a round trip.
    demoFilterCounts(),
  ]);

  return (
    <Worklist
      section="demo"
      initialLeads={result.leads}
      initialMeta={{
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      }}
      initialCategories={categories}
      initialLocations={locations}
      initialDemos={demos}
      initialDemoCounts={demoCounts}
      serverToday={today}
    />
  );
}

/** `?page=2&page=3` is a malformed URL, not a range. Take the first. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
