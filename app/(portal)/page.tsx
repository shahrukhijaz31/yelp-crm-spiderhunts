import Worklist from "@/components/Worklist";
import { requireUser } from "@/lib/authz";
import { EMPTY_FILTERS } from "@/lib/filters";
import { leadCategories, listLeadsPage } from "@/lib/leadDb";
import { readPage, readPageSize } from "@/lib/leadQuery";
import { todayIso } from "@/lib/leadUtils";

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
    view: "all",
    filters: EMPTY_FILTERS,
    today,
    page: readPage(one(params.page)),
    pageSize: readPageSize(one(params.pageSize)),
  });

  // The full category list, for the filter panel. Read once here rather than
  // with every page: it changes when someone imports a CSV, not when an agent
  // ticks a box, and the panel needs all of them to be searchable.
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
