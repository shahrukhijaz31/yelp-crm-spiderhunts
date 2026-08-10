import Worklist from "@/components/Worklist";
import { requireUser } from "@/lib/authz";
import { EMPTY_FILTERS } from "@/lib/filters";
import { leadCategories, listLeadsPage } from "@/lib/leadDb";
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
 * `requireUser` is repeated even though the portal layout already ran it. It
 * costs nothing (the session lookup is memoised per request) and it means no
 * lead is read on the strength of an assumption about what a parent did.
 */
export default async function Home(props: PageProps<"/">) {
  await requireUser();

  const params = await props.searchParams;
  const today = todayIso();

  const result = await listLeadsPage({
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
  const categories = await leadCategories();

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
      serverToday={today}
    />
  );
}

/** `?page=2&page=3` is a malformed URL, not a range. Take the first. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
