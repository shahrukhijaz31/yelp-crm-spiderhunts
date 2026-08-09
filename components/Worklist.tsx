"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import Breakdown from "./Breakdown";
import FilterToolbar from "./FilterToolbar";
import HeadlineStrip from "./HeadlineStrip";
import LeadTable from "./LeadTable";
import Pagination from "./Pagination";
import ViewTabs from "./ViewTabs";
import { usePortalStats } from "./PortalStatsProvider";
import { useLeadEditor } from "./useLeadEditor";
import { EMPTY_FILTERS, type CategoryOption, type LeadFilters } from "@/lib/filters";
import { todayIso, type LeadStats } from "@/lib/leadUtils";
import {
  buildLeadSearchParams,
  DEFAULT_SORT,
  type LeadPageMeta,
  type LeadSort,
  type LeadSortKey,
  type PageSize,
} from "@/lib/leadQuery";
import type { Lead } from "@/lib/types";
import { WORKLIST_VIEW_HINTS, type WorklistView } from "@/lib/views";

/**
 * The worklist screen: headline strip → tabs → (optional breakdown) → filter
 * toolbar → table → pager.
 *
 * Two layers of narrowing, deliberately separate: the tab picks the *scope* an
 * agent is working ("everything I owe a callback"), and the toolbar filters
 * *within* it.
 *
 * **Both now run in Postgres.** This component used to read every lead out of
 * `LeadsProvider` and narrow the array on each render, which was fine at a few
 * hundred rows and stopped being fine somewhere past a thousand: the browser
 * was handed the entire table on every page load in order to display twenty of
 * it. The tab, the filters, the page and the page size are instead sent to
 * `GET /api/leads`, which returns one page and a count of everything that
 * matched. The payload is bounded by the page size from here on, whatever the
 * scraper adds.
 *
 * What that costs, and what is done about it:
 *
 *   - **A round trip per change.** Search is debounced so a fetch is not fired
 *     per keystroke; everything else (a tab, a checkbox, a page) is a single
 *     deliberate act and goes at once. The previous page's rows stay on screen,
 *     dimmed, rather than blanking the table between requests.
 *   - **Responses can arrive out of order.** Each request aborts the one before
 *     it, and a response is only applied if its request is still the current
 *     one — otherwise a slow "all leads" fetch could overwrite the fast
 *     "overdue" one an agent asked for afterwards.
 *   - **The counts are no longer derivable here.** They come back with the page
 *     and are pushed into the portal-wide store so the nav bar agrees with the
 *     strip. After an inline edit the counts are re-read (rows deliberately are
 *     not — see the route handler).
 *
 * The first page is rendered on the server and handed in, so this screen paints
 * with data rather than with a spinner; the effect below recognises that it
 * already has that exact page and does not re-request it.
 */

/** Identifies a request, so one already answered is not made twice. */
function fetchKey(
  view: WorklistView,
  filters: LeadFilters,
  sort: LeadSort,
  today: string,
  page: number,
  pageSize: number,
): string {
  return JSON.stringify([view, filters, sort, today, page, pageSize]);
}

/** How long the search box may go quiet before the query is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/** How long edits may keep landing before the counts are re-read. */
const STATS_REFRESH_DEBOUNCE_MS = 400;

/** Poll the clock so the "due today" view is still correct after midnight. */
function subscribeToDayChange(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

export default function Worklist({
  initialLeads,
  initialMeta,
  initialCategories,
  serverToday,
}: {
  initialLeads: Lead[];
  initialMeta: LeadPageMeta;
  initialCategories: CategoryOption[];
  serverToday: string;
}) {
  const { stats, setStats } = usePortalStats();

  const [view, setView] = useState<WorklistView>("all");
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<LeadSort>(DEFAULT_SORT);
  const [page, setPage] = useState(initialMeta.page);
  const [pageSize, setPageSize] = useState<PageSize>(initialMeta.pageSize as PageSize);

  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [meta, setMeta] = useState<LeadPageMeta>(initialMeta);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // "Today" comes from the server for the SSR/hydration render, then from the
  // agent's own clock — so callback highlighting uses their timezone, and a
  // portal left open overnight rolls over on its own. When the two differ the
  // effect below simply sees a new key and re-asks with the right date.
  const today = useSyncExternalStore(subscribeToDayChange, todayIso, () => serverToday);

  // Typing is instant — the field, the chips and the Filters badge all follow
  // `filters` — but the *query* waits for a pause. Without this an agent typing
  // a business name fires one request per letter, and the answers race.
  const query = useDebounced(filters.query, SEARCH_DEBOUNCE_MS);
  const appliedFilters = useMemo<LeadFilters>(
    () => ({ ...filters, query }),
    [filters, query],
  );

  /*
   * Any change to *what* is being looked at returns to page one. Page 4 of an
   * unfiltered list has nothing to do with page 4 of a search, and landing on
   * an empty page after typing is the classic way a paginated table looks
   * broken. Done during render rather than in an effect so the reset and the
   * criteria change are one update, and the fetch below is made once.
   *
   * The sort counts as a change of criteria for the same reason. Re-ordering
   * by business name and staying on page 4 lands an agent in the middle of the
   * alphabet, which is not where anyone means to be after clicking a heading.
   */
  const criteriaKey = JSON.stringify([view, appliedFilters, sort, today]);
  const [lastCriteria, setLastCriteria] = useState(criteriaKey);
  if (lastCriteria !== criteriaKey) {
    setLastCriteria(criteriaKey);
    setPage(1);
  }
  const effectivePage = lastCriteria === criteriaKey ? page : 1;

  // Seeded with the page the server already rendered, which is what stops this
  // screen from fetching on mount the data it was handed.
  const settledKey = useRef(
    fetchKey(
      "all",
      EMPTY_FILTERS,
      DEFAULT_SORT,
      serverToday,
      initialMeta.page,
      initialMeta.pageSize,
    ),
  );

  useEffect(() => {
    const request = {
      view,
      filters: appliedFilters,
      sort,
      today,
      page: effectivePage,
      pageSize,
    };
    const requestKey = fetchKey(
      request.view,
      request.filters,
      request.sort,
      request.today,
      request.page,
      request.pageSize,
    );
    // Re-running with identical criteria — a filter set back to the value it
    // already had, say — is not a new question, so it does not get a new fetch.
    if (settledKey.current === requestKey) return;

    const controller = new AbortController();
    setBusy(true);

    void (async () => {
      try {
        const params = buildLeadSearchParams(request);
        const response = await fetch(`/api/leads?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`GET /api/leads responded ${response.status}`);
        }
        const data = (await response.json()) as LeadPageMeta & {
          leads: Lead[];
          stats: LeadStats;
        };

        // The server clamps a page past the end of the result set, so record
        // the page it actually served — otherwise the state change below reads
        // as a new request and fetches the same rows a second time.
        settledKey.current = fetchKey(
          request.view,
          request.filters,
          request.sort,
          request.today,
          data.page,
          data.pageSize,
        );

        setLeads(data.leads);
        setMeta({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          totalPages: data.totalPages,
        });
        if (data.page !== request.page) setPage(data.page);
        setStats(data.stats);
        setError(null);
      } catch (caught) {
        // An aborted request is this component superseding itself, not a
        // failure — the newer request owns the screen and will report its own.
        if (controller.signal.aborted) return;
        console.error("Loading leads failed:", caught);
        setError(
          "Could not load leads. The rows below may be out of date — check your connection and try again.",
        );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();

    return () => controller.abort();
    // `appliedFilters` is memoised and `setStats` is stable, so these are the
    // six values that actually describe a request plus the one way to report
    // its counts — this does not re-run per render.
  }, [view, appliedFilters, sort, today, effectivePage, pageSize, setStats]);

  /*
   * Page and page size live in the address bar so a reload, a bookmark or a
   * restored tab keeps its place. Written with the history API rather than
   * `router.replace` on purpose: this is state the client already holds and has
   * already fetched, so a navigation would send the server component off to
   * fetch it a second time to render the same screen.
   *
   * The tab and the filters are left out. They change on almost every
   * interaction, and putting them here would make the back button walk an agent
   * backwards through their own typing.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(meta.page));
    params.set("pageSize", String(meta.pageSize));
    const next = `${window.location.pathname}?${params}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [meta.page, meta.pageSize]);

  /*
   * After an edit is saved, re-read the counts. The strip, the tab badges and
   * the status tallies in the filter panel used to move on the same tick as the
   * chip because the browser held every lead and could count them; it no longer
   * does, so this is the closest honest equivalent — a counts-only request
   * (`rows=0`), debounced so working quickly down a column is one round trip
   * rather than one per row.
   */
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (statsTimer.current) clearTimeout(statsTimer.current);
    },
    [],
  );

  const refreshStats = useCallback(() => {
    if (statsTimer.current) clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => {
      // The counts ignore the tab and the filters, so the only thing this
      // request carries is the agent's date — which decides what "overdue" and
      // "due today" mean.
      const params = new URLSearchParams({ rows: "0", today });
      void fetch(`/api/leads?${params}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { stats: LeadStats } | null) => {
          if (data) setStats(data.stats);
        })
        .catch((caught) => console.error("Refreshing lead counts failed:", caught));
    }, STATS_REFRESH_DEBOUNCE_MS);
  }, [today, setStats]);

  const updateLead = useLeadEditor(leads, setLeads, refreshStats);

  // The tab badges are slices of the same workspace-wide aggregate, so they
  // need no query of their own: "needs callback" is due-today plus overdue,
  // "overdue" is the overdue count, and "missing website" is already counted.
  const counts = useMemo<Record<WorklistView, number>>(
    () => ({
      all: stats.total,
      callback: stats.callbackDueToday + stats.callbackOverdue,
      overdue: stats.callbackOverdue,
      issues: stats.missingWebsite,
    }),
    [stats],
  );

  /*
   * A heading click cycles that column: ascending, then descending, then off.
   *
   * The third step matters more here than in most tables. The default order is
   * the order the leads were imported in, which is the order a scraped batch is
   * meant to be worked down — so "put it back" has to be reachable from the
   * same control that moved it, without hunting for a reset button.
   *
   * Moving to a different column always starts at ascending, whatever the last
   * column was doing: a click on "Address" means "show me these by address",
   * not "continue descending".
   */
  function cycleSort(key: LeadSortKey) {
    setSort((current) => {
      if (current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      // Back to the default *exactly* — a `{ key: "default", direction: "desc" }`
      // would send the same request as the default one but read as a different
      // state, and the worklist would re-fetch a page it already has.
      return DEFAULT_SORT;
    });
  }

  function changePageSize(next: PageSize) {
    setPageSize(next);
    // Page 12 at 20 rows is not page 12 at 100, and there may not be a page 12
    // any more. Back to the top, which is also where an agent expects to be
    // after changing how much of the list they can see.
    setPage(1);
  }

  return (
    /*
     * The page is a column: a summary strip, then one workspace surface that
     * fills whatever height is left.
     *
     * That surface is the structural change. It used to be four separately
     * bordered cards stacked with margins between them — tabs, toolbar, table,
     * pager — which is the shape of a dashboard rather than of a tool. They are
     * now sections *of one object*, joined by hairlines: the controls sit on
     * the thing they control, and only the rows scroll, so the toolbar and the
     * pager stay on screen however long the list is.
     */
    <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
      <HeadlineStrip stats={stats} />

      <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* --- view switcher ------------------------------------------- */}
        <div className="panel-rail flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2.5">
          <ViewTabs
            view={view}
            counts={counts}
            onChange={setView}
            breakdownOpen={breakdownOpen}
            onToggleBreakdown={() => setBreakdownOpen((open) => !open)}
          />

          {/* What the current tab means, in one line. Beside the control
              rather than under it: it is a caption for the segment that is
              selected, and putting it on its own row cost a whole band of
              vertical space to say six words. */}
          <p className="hidden text-caption text-fg-4 xl:block">
            {WORKLIST_VIEW_HINTS[view]}
          </p>
        </div>

        {breakdownOpen && (
          <div className="border-b border-line bg-recessed px-4 py-4">
            <Breakdown stats={stats} />
          </div>
        )}

        {/* --- command bar --------------------------------------------- */}
        <div className="panel-rail border-b border-line">
          <FilterToolbar
            filters={filters}
            onChange={setFilters}
            categories={initialCategories}
            stats={stats}
            shown={meta.total}
            open={filtersOpen}
            onToggleOpen={() => setFiltersOpen((open) => !open)}
          />
        </div>

        {error && (
          <p
            role="alert"
            className="flex items-start gap-2.5 border-b border-danger-line bg-danger-bg px-4 py-2.5 text-caption text-danger"
          >
            {error}
          </p>
        )}

        {/* --- rows ----------------------------------------------------- */}
        {/* Dimmed rather than emptied while a request is in flight: the rows
            underneath are the ones the agent was just reading, and replacing
            them with a spinner for 80ms makes the whole table flicker on every
            page turn. `aria-busy` says the same thing to a screen reader. */}
        <div
          aria-busy={busy}
          className={`flex min-h-0 flex-1 flex-col transition-opacity duration-150 ${
            busy ? "pointer-events-none opacity-55" : ""
          }`}
        >
          <LeadTable
            leads={leads}
            today={today}
            sort={sort}
            onSort={cycleSort}
            onUpdate={updateLead}
            // What the rows *are*, not what they contain: the page, the size
            // and the criteria. `lastCriteria` already encodes the tab, the
            // applied filters, the sort and the date.
            datasetKey={`${lastCriteria}|${meta.page}|${meta.pageSize}`}
          />
        </div>

        {/* --- pager ---------------------------------------------------- */}
        <Pagination
          page={meta.page}
          pageSize={meta.pageSize}
          total={meta.total}
          totalPages={meta.totalPages}
          busy={busy}
          onPageChange={setPage}
          onPageSizeChange={changePageSize}
        />
      </section>
    </main>
  );
}

/**
 * A value that only settles after it has stopped changing for `delay`.
 *
 * Used for the search box alone. The other filters are single clicks with a
 * considered result; typing is a stream of intermediate states nobody wants an
 * answer to.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
