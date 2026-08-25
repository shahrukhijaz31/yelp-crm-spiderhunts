import { redirect } from "next/navigation";

import AccessDenied from "@/components/AccessDenied";
import Worklist from "@/components/Worklist";
import { requireModule } from "@/lib/authz";
import { landingPathFor } from "@/lib/modules";
import { EMPTY_FILTERS } from "@/lib/filters";
import { leadCategories, leadLocations, listLeadsPage } from "@/lib/leadDb";
import { DEFAULT_SORT, readPage, readPageSize } from "@/lib/leadQuery";
import { todayIso } from "@/lib/leadUtils";
import { DEFAULT_WORK_STATE } from "@/lib/workState";

/**
 * The worklist.
 *
 * It used to be one line — the whole lead table was seeded into `LeadsProvider`
 * by the portal layout and this route just mounted the view. That is what
 * pagination removes: the layout no longer reads any leads, and the first page
 * of them is fetched here instead, so the response contains twenty rows rather
 * than the table.
 *
 * Rendering the first page server-side rather than letting the client ask for
 * it on mount is what keeps this screen painting with data. `Worklist`
 * recognises the page it was handed and does not re-request it.
 *
 * Only `page` and `pageSize` are read from the URL. They are the two an agent
 * benefits from keeping across a reload; the tab and the filters stay in the
 * component, because writing them here would turn every keystroke in the search
 * box into a server round trip for a whole new screen. Both values are parsed
 * by the same validators the API route uses — `?pageSize=100000` is a request
 * for the default page size, not for the table.
 *
 * The guard is repeated even though the portal layout already ran one. It costs
 * nothing (both lookups are memoised per request) and it means no lead is read
 * on the strength of an assumption about what a parent did.
 *
 * ---------------------------------------------------------------------------
 * When the worklist is not this account's home
 * ---------------------------------------------------------------------------
 * `/` is where every sign-in lands, and it is the worklist — which is wrong for
 * an agent whose account has Demo Websites and not Leads. Refusing them here
 * would mean the first screen after signing in is an Access Denied, which reads
 * as a broken account rather than as a deliberate grant, so they are sent to the
 * module they *do* have instead.
 *
 * The redirect is not a permission and does not stand in for one: an agent with
 * neither module gets the refusal screen, and the Demo Websites page runs its
 * own guard when they arrive. What this decides is where somebody lands, not
 * what they may read.
 */
export default async function Home(props: PageProps<"/">) {
  const { access, allowed } = await requireModule("leads");
  if (!allowed) {
    const elsewhere = landingPathFor(access);
    if (elsewhere && elsewhere !== "/") redirect(elsewhere);
    return <AccessDenied />;
  }

  const params = await props.searchParams;
  const today = todayIso();

  const result = await listLeadsPage({
    // The worklist, as opposed to Demo Websites — which is this same query and
    // this same component with the other section (`/demo-websites`). Named
    // rather than defaulted so the two pages read as the pair they are.
    section: "leads",
    // The queue the screen opens on — New, the leads nobody has called. Not
    // read from the URL for the same reason the tab and the filters are not:
    // `Worklist` owns it from the first interaction onwards, and it is seeded
    // with the same default here so the server renders the page the client is
    // about to recognise as the one it already has.
    workState: DEFAULT_WORK_STATE,
    view: "all",
    filters: EMPTY_FILTERS,
    // The first paint is always the unsorted list, for the same reason the tab
    // and the filters are not read from the URL: a heading click is client
    // state the browser already holds, and putting it here would send the
    // server off to render a whole new screen for a change of ORDER BY.
    sort: DEFAULT_SORT,
    today,
    page: readPage(one(params.page)),
    pageSize: readPageSize(one(params.pageSize)),
  });

  // The full category list, for the filter panel. Read once here rather than
  // with every page: it changes when someone imports a CSV, not when an agent
  // ticks a box, and the panel needs all of them to be searchable.
  //
  // The New/Called counts are *not* read here: the sidebar shows them on every
  // screen, so they are the layout's job (`LeadQueueProvider`), and reading
  // them again would be a second identical aggregate per page load.
  // The location lists are read on the same terms and for the same reason: the
  // countries and towns in the table change with an import, not with a
  // keystroke. Concurrent, because neither aggregate depends on the other.
  const [categories, locations] = await Promise.all([
    leadCategories(),
    leadLocations(),
  ]);

  return (
    <Worklist
      initialLeads={result.leads}
      initialMeta={{
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      }}
      initialCategories={categories}
      initialLocations={locations}
      serverToday={today}
    />
  );
}

/** `?page=2&page=3` is a malformed URL, not a range. Take the first. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
