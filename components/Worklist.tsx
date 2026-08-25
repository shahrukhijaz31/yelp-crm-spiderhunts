"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { AnimatePresence } from "framer-motion";

import Breakdown from "./Breakdown";
import type { DemoCounts } from "./FilterPanel";
import FilterToolbar from "./FilterToolbar";
import HeadlineStrip from "./HeadlineStrip";
import LeadOverlay from "./LeadOverlay";
import LeadTable from "./LeadTable";
import MyDayStrip from "./MyDayStrip";
import Pagination from "./Pagination";
import ViewTabs from "./ViewTabs";
import { useLeadQueue } from "./LeadQueueProvider";
import { usePortalStats } from "./PortalStatsProvider";
import type { DemoSummary, DemoSummaryMap } from "@/lib/demoWebsiteRules";
import {
  EMPTY_FILTERS,
  type CategoryOption,
  type LeadFilters,
  type CountryOption,
} from "@/lib/filters";
import { leadPosition, leadWorkspaceHref } from "@/lib/leadLink";
import { todayIso, type LeadStats } from "@/lib/leadUtils";
import {
  buildLeadSearchParams,
  DEFAULT_SORT,
  type LeadPageMeta,
  type LeadPageQuery,
  type LeadSection,
  type LeadSort,
  type LeadSortKey,
  type PageSize,
} from "@/lib/leadQuery";
import type { RecordingSummary } from "@/lib/recordingRules";
import type { Lead } from "@/lib/types";
import { WORKLIST_VIEW_HINTS, type WorklistView } from "@/lib/views";
import {
  DEFAULT_WORK_STATE,
  LEAD_WORK_STATE_HINTS,
  LEAD_WORK_STATE_LABELS,
  type LeadWorkCounts,
  type LeadWorkState,
} from "@/lib/workState";

/**
 * The worklist screen: headline strip → tabs → (optional breakdown) → filter
 * toolbar → table → pager.
 *
 * Three layers of narrowing, deliberately separate and in that order: the queue
 * picks *which list* is being worked (New — never called — or Called; see
 * `lib/workState.ts`), the tab picks the *scope* within it ("everything I owe a
 * callback"), and the toolbar filters within that. All three travel to Postgres
 * together, so "New + Dental + page 3" is one query and one page of rows.
 *
 * Only the outermost of the three is not drawn here. The queue is chosen in the
 * sidebar and read from `LeadQueueProvider`, so this screen shows it as a label
 * and reacts to it like any other change of criteria — a new key, one bounded
 * fetch, the old rows dimmed until it lands.
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
 *     strip. They are re-read when this tab comes back to the front, which is
 *     when a lead worked in another tab has just changed them (rows
 *     deliberately are not — see the route handler).
 *
 * **This screen no longer edits.** Status, meetings and notes moved to the
 * lead's own page (`/leads/[id]`), which opens in a new tab from any row. What
 * is left here is discovery — narrow the list, find the lead, open it — and the
 * three layers of narrowing below are exactly that job.
 *
 * The first page is rendered on the server and handed in, so this screen paints
 * with data rather than with a spinner; the effect below recognises that it
 * already has that exact page and does not re-request it.
 */

/** Identifies a request, so one already answered is not made twice. */
function fetchKey(
  section: LeadSection,
  workState: LeadWorkState,
  view: WorklistView,
  filters: LeadFilters,
  sort: LeadSort,
  today: string,
  page: number,
  pageSize: number,
): string {
  return JSON.stringify([section, workState, view, filters, sort, today, page, pageSize]);
}

/** How long the search box may go quiet before the query is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/** How long a return to this tab settles before the counts are re-read. */
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
  initialCountries,
  initialDemos,
  initialDemoCounts,
  section = "leads",
  serverToday,
}: {
  initialLeads: Lead[];
  initialMeta: LeadPageMeta;
  initialCategories: CategoryOption[];
  initialCountries: CountryOption[];
  /**
   * Demo metadata for the first page, when the demo view rendered it. Sparse,
   * and absent for the worklist, which draws no demo columns.
   */
  initialDemos?: DemoSummaryMap;
  /** The demo filter's counts for the first paint. Demo view only. */
  initialDemoCounts?: DemoCounts;
  /**
   * Which of the two views this is.
   *
   * **The same screen, the same query and the same leads either way.** The
   * queue, the tabs, the filters, the search, the sort and the pager are
   * identical, because they are one implementation over one lead pool — what
   * changes is the two columns at the right of each row, the audio the demo
   * view does not draw, and which module the endpoint behind it demands.
   *
   * This is not what enforces the permission. `GET /api/leads` picks its guard
   * from the section it is *sent* and re-reads the module from the `users` row
   * in Postgres; the page above this component runs the same check before a
   * lead is read at all.
   */
  section?: LeadSection;
  serverToday: string;
}) {
  const demoSection = section === "demo";
  const { stats, setStats } = usePortalStats();

  // Which queue — New or Called — chosen in the sidebar and held for the whole
  // shell, because the control and this screen are on opposite sides of the
  // layout. It starts on the queue the server rendered the first page under.
  // `setWorkCounts` sends the fresh numbers back the other way, so the badges
  // in the rail move when an agent saves an outcome.
  const { workState, setCounts: setWorkCounts } = useLeadQueue();

  const [view, setView] = useState<WorklistView>("all");
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<LeadSort>(DEFAULT_SORT);
  const [page, setPage] = useState(initialMeta.page);
  const [pageSize, setPageSize] = useState<PageSize>(initialMeta.pageSize as PageSize);

  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [meta, setMeta] = useState<LeadPageMeta>(initialMeta);
  const [busy, setBusy] = useState(false);

  // Bumped whenever a save lands, so the "My day" band re-reads the agent's own
  // figures. A counter rather than the figures themselves: this screen has no
  // business knowing what they are or where they come from.
  const [dayRevision, setDayRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  /*
   * Which leads already have a call recording, keyed by lead id.
   *
   * One request, once, for the whole screen — and deliberately *not* part of
   * the paged leads query above, which is re-asked on every tab, filter, sort
   * and page change. Recordings only change when one is uploaded, and when that
   * happens the answer is already in hand: the POST returns the saved summary,
   * so the row updates from the response rather than from a re-read.
   *
   * The server decides what is in here (`GET /api/recordings` → the same
   * `listRecordingsFor` the Meetings page uses), so an agent is only ever told
   * about their own uploads and an admin about all of them. An empty map is a
   * perfectly good answer: the column simply offers to upload.
   */
  const [recordings, setRecordings] = useState<Record<string, RecordingSummary>>({});

  /*
   * The demo image and link for the rows on screen, keyed by lead id.
   *
   * Unlike `recordings` above, this arrives *with* the page rather than in a
   * request of its own, and the difference is volume: recordings are rare
   * enough to fetch for the whole workspace once, while demo metadata is a
   * per-lead thing on a table of twenty thousand. It is asked for by lead id,
   * bounded by the page, on the same round trip that fetched the page.
   *
   * Sparse by design — a lead with no demo row has no entry, and the cells draw
   * "upload" and "add link". That is what makes every pre-existing lead appear
   * here with nothing having been backfilled.
   */
  const [demos, setDemos] = useState<DemoSummaryMap>(initialDemos ?? {});

  /**
   * How many leads sit behind each demo filter option.
   *
   * Workspace-wide and unfiltered, like the stats in the strip above — they are
   * the numbers on the filter buttons, so a count that already had the filter
   * applied would show every option but the chosen one as zero. Arrives with
   * the page and is replaced by each response.
   */
  const [demoCounts, setDemoCounts] = useState<DemoCounts | undefined>(initialDemoCounts);

  /*
   * Which lead is open over this list, and where in the list it was.
   *
   * `null` is the list on its own, which is what this screen shows for most of
   * its life. When it is not null it carries all three of the things the window
   * needs, and each is there for a reason:
   *
   *   id      what the window fetches and holds. Kept *beside* the index rather
   *           than looked up through it, so a row set that changes underneath
   *           the window — a page turn, a midnight re-read — can never swap the
   *           lead an agent is mid-call on for whatever now occupies row 4.
   *   name    known from the row that was clicked, so the window's header is
   *           real before its request lands.
   *   index   where Previous and Next step from.
   */
  const [open, setOpen] = useState<{ id: string; name: string; index: number } | null>(
    null,
  );

  /*
   * Next at the bottom of a page, or Previous at the top of one, has to cross
   * a page boundary — and the rows for the next page are not here yet. This
   * records which end of the incoming page to open, and the fetch below acts on
   * it once the rows land. A ref, not state: nothing renders differently for
   * the 100ms it is set, and it must not itself cause a render.
   */
  const pendingEdge = useRef<"first" | "last" | null>(null);

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
  const criteriaKey = JSON.stringify([section, workState, view, appliedFilters, sort, today]);
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
      section,
      DEFAULT_WORK_STATE,
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
      section,
      workState,
      view,
      filters: appliedFilters,
      sort,
      today,
      page: effectivePage,
      pageSize,
    };
    const requestKey = fetchKey(
      request.section,
      request.workState,
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
          workCounts: LeadWorkCounts;
          demos?: DemoSummaryMap;
          demoCounts?: DemoCounts;
        };

        // The server clamps a page past the end of the result set, so record
        // the page it actually served — otherwise the state change below reads
        // as a new request and fetches the same rows a second time.
        settledKey.current = fetchKey(
          request.section,
          request.workState,
          request.view,
          request.filters,
          request.sort,
          request.today,
          data.page,
          data.pageSize,
        );

        setLeads(data.leads);
        // Replaced wholesale rather than merged: the map describes *this* page,
        // and keeping entries for rows no longer on screen would grow without
        // bound as an agent pages through twenty thousand leads.
        if (data.demos) setDemos(data.demos);
        if (data.demoCounts) setDemoCounts(data.demoCounts);

        // A page turned from inside the workspace: open the row the agent was
        // walking towards, at whichever end of the new page it arrived at. An
        // empty page ends the walk and leaves the list on screen.
        if (pendingEdge.current) {
          const edge = pendingEdge.current;
          pendingEdge.current = null;
          const index = edge === "first" ? 0 : data.leads.length - 1;
          const row = data.leads[index];
          setOpen(row ? { id: row.id, name: row.name, index } : null);
        }

        setMeta({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          totalPages: data.totalPages,
        });
        if (data.page !== request.page) setPage(data.page);
        setStats(data.stats);
        if (data.workCounts) setWorkCounts(data.workCounts);
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
    // `appliedFilters` is memoised and both setters are stable, so these are
    // the seven values that actually describe a request plus the two ways of
    // reporting its counts — this does not re-run per render.
  }, [
    section,
    workState,
    view,
    appliedFilters,
    sort,
    today,
    effectivePage,
    pageSize,
    setStats,
    setWorkCounts,
  ]);

  useEffect(() => {
    /*
     * Not in the demo view, and this is the load-bearing half of "no audio in
     * Demo Websites": the request is never made, so the browser never learns
     * which leads have recordings and there is nothing for a stray control to
     * render from. An agent granted only Demo Websites would be refused this
     * endpoint anyway (it sits behind the Leads module), and not asking is how
     * that refusal stays invisible rather than logging a 403 per page load.
     */
    if (demoSection) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/recordings", { signal: controller.signal });
        if (!response.ok) return;
        const data = (await response.json()) as {
          recordings?: Record<string, RecordingSummary>;
        };
        if (data.recordings) setRecordings(data.recordings);
      } catch (caught) {
        // Not worth an error banner: the list is entirely usable without this,
        // and the only cost of it failing is that a lead with audio shows an
        // upload arrow instead of the attached glyph. The upload itself would
        // still work, and the server would still refuse a replace it should.
        if (controller.signal.aborted) return;
        console.error("Loading call recordings failed:", caught);
      }
    })();

    return () => controller.abort();
  }, [demoSection]);

  /** A quick upload from a row. One entry changes; nothing is re-fetched. */
  const handleRecordingSaved = useCallback((saved: RecordingSummary) => {
    setRecordings((current) => ({ ...current, [saved.leadId]: saved }));
  }, []);

  /**
   * A demo image or link saved from a row or from the window.
   *
   * One entry changes and nothing is re-fetched: the PATCH and the upload both
   * return the saved summary, so the cell and the map agree without a re-read —
   * the same contract the recording upload keeps.
   */
  const handleDemoSaved = useCallback((leadId: string, saved: DemoSummary) => {
    setDemos((current) => ({ ...current, [leadId]: saved }));
  }, []);

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
   * Re-read the counts when this tab comes back to the front.
   *
   * This used to run after an inline save, because the row that changed was on
   * this screen. It is not any more: a lead is worked in its own tab, and the
   * agent returns here with a status changed, a lead moved from New to Called
   * and every number in the strip, the tab badges and the sidebar one out of
   * date. The moment they look at this screen again is exactly the moment those
   * numbers have to be right, so that is when they are re-read.
   *
   * A counts-only request (`rows=0`) — deliberately not the rows. Re-fetching
   * the page would re-apply the filters and could take the lead the agent just
   * worked out from under the cursor they are about to move to the next one
   * with; losing your place is not a refresh. The rows update on the next
   * deliberate change of page, tab or filter.
   *
   * Debounced, because a browser fires `focus` and `visibilitychange` together
   * when a tab is re-selected and that is one return, not two.
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
        .then((data: { stats: LeadStats; workCounts: LeadWorkCounts } | null) => {
          if (!data) return;
          setStats(data.stats);
          if (data.workCounts) setWorkCounts(data.workCounts);
        })
        .catch((caught) => console.error("Refreshing lead counts failed:", caught));
    }, STATS_REFRESH_DEBOUNCE_MS);
  }, [today, setStats, setWorkCounts]);

  useEffect(() => {
    function onReturn() {
      if (document.visibilityState === "visible") refreshStats();
    }
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refreshStats]);

  /*
   * Where a row points **when the browser opens it rather than this screen**.
   *
   * A plain click opens the workspace over this list and never uses this
   * address. A Ctrl/Cmd-click, a middle click or "open in new tab" does, and
   * lands on `/leads/[id]` with no worklist behind it — so the address still
   * has to carry the list itself: the queue, the tab, the applied filters, the
   * sort, the page, written with `buildLeadSearchParams`, the same function
   * that asks the API for this page. That is what lets the *page* frame's
   * "Next lead" mean the next lead in what the agent was looking at, in a tab
   * that started with no memory of this one.
   *
   * The ordinal is over the whole result set, not the page, so Next walks on
   * past row twenty instead of returning to the top of it.
   */
  const linkQuery = useMemo<LeadPageQuery>(
    () => ({
      section,
      workState,
      view,
      filters: appliedFilters,
      sort,
      today,
      page: meta.page,
      pageSize: meta.pageSize as PageSize,
    }),
    [section, workState, view, appliedFilters, sort, today, meta.page, meta.pageSize],
  );

  const hrefFor = useCallback(
    (lead: Lead, index: number) =>
      leadWorkspaceHref(
        lead.id,
        linkQuery,
        leadPosition(meta.page, meta.pageSize, index),
      ),
    [linkQuery, meta.page, meta.pageSize],
  );

  /* ----------------------------------------------------------------------
   * The lead window
   *
   * Opening one costs a single request for a single lead (see `LeadOverlay`);
   * this screen is not re-queried, re-rendered from the server or navigated
   * away from, which is the whole point. Everything below is bookkeeping about
   * *which* row is open — no data is fetched here.
   * -------------------------------------------------------------------- */

  const openLead = useCallback(
    (index: number) => {
      const lead = leads[index];
      if (lead) setOpen({ id: lead.id, name: lead.name, index });
    },
    [leads],
  );

  const closeLead = useCallback(() => setOpen(null), []);

  /*
   * Previous and Next walk the list the agent is actually looking at — the
   * same queue, tab, filters, sort and page — because they walk the rows this
   * screen already fetched. At the edge of a page they turn it and open the row
   * that continues the sequence, which is the only case that touches the
   * network, and it fetches a page of the list rather than anything extra.
   */
  const stepTo = useCallback(
    (delta: 1 | -1) => {
      setOpen((current) => {
        if (!current) return current;

        const next = current.index + delta;
        const lead = leads[next];
        if (lead) return { id: lead.id, name: lead.name, index: next };

        // Off the end of this page. Ask for the neighbouring one and let the
        // fetch open whichever row continues the walk; the window stays on the
        // current lead until those rows land.
        const target = meta.page + delta;
        if (target < 1 || target > meta.totalPages) return current;
        pendingEdge.current = delta === 1 ? "first" : "last";
        setPage(target);
        return current;
      });
    },
    [leads, meta.page, meta.totalPages],
  );

  const hasPrev = open !== null && (open.index > 0 || meta.page > 1);
  const hasNext =
    open !== null && (open.index < leads.length - 1 || meta.page < meta.totalPages);

  const goPrev = useCallback(() => stepTo(-1), [stepTo]);
  const goNext = useCallback(() => stepTo(1), [stepTo]);

  /*
   * A lead saved in the window, written back into the row behind it.
   *
   * The row is replaced, not re-fetched: the response to the PATCH *is* the
   * saved row, so the chip in the table and the window on top of it cannot
   * disagree about a status the agent just committed. The rows are deliberately
   * left otherwise alone — re-running the query here could take the lead out
   * from under the window mid-call, since saving an outcome is exactly what
   * moves a lead out of the New queue. The counts are a different matter: they
   * are what the strip and the sidebar badges show, and they are wrong the
   * moment a save lands.
   */
  const handleSaved = useCallback(
    (saved: Lead) => {
      setLeads((current) =>
        current.map((row) => (row.id === saved.id ? saved : row)),
      );
      refreshStats();
      // A save is also the moment the agent's own day changed — the server has
      // just written the activity row it is counted from. Bumping a counter
      // rather than calling into the strip keeps this screen ignorant of how
      // that band fetches its figures.
      setDayRevision((current) => current + 1);
    },
    [refreshStats],
  );

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
      {/* The agent's own day, above the workspace's. Their figures first
          because they are the ones a person can do something about in the next
          hour; the list's totals are the context underneath. Own row only —
          this band never shows anybody else's numbers, and the endpoint behind
          it cannot be asked for them. */}
      <MyDayStrip revision={dayRevision} />

      <HeadlineStrip stats={stats} />

      <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* --- view switcher ------------------------------------------- */}
        <div className="panel-rail flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {/*
             * Which queue is on screen. A label, not a control — the queue is
             * chosen in the sidebar, and two ways to change one thing is how
             * they start disagreeing.
             *
             * It is here at all because the rail does not survive every width:
             * it collapses to icons on a laptop and off-canvas on a phone, and
             * a worklist that cannot say whether it is showing called leads is
             * a worklist an agent has to guess at. Reads as one phrase with the
             * views beside it — "New · All leads" — which is exactly the scope.
             */}
            <span
              className="flex shrink-0 items-center gap-2 text-ui font-semibold tracking-[-0.01em] text-fg"
              title={LEAD_WORK_STATE_HINTS[workState]}
            >
              <span
                aria-hidden="true"
                className={`queue-dot ${
                  workState === "new" ? "bg-st-sky" : "bg-fg-4"
                }`}
              />
              {LEAD_WORK_STATE_LABELS[workState]}
            </span>

            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />

            <ViewTabs
              view={view}
              counts={counts}
              onChange={setView}
              breakdownOpen={breakdownOpen}
              onToggleBreakdown={() => setBreakdownOpen((open) => !open)}
            />
          </div>

          {/* What the current tab means, in one line. Beside the control
              rather than under it: it is a caption for the segment that is
              selected, and putting it on its own row cost a whole band of
              vertical space to say six words. */}
          <p className="hidden text-caption text-fg-3 xl:block">
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
            countries={initialCountries}
            stats={stats}
            shown={meta.total}
            open={filtersOpen}
            onToggleOpen={() => setFiltersOpen((open) => !open)}
            section={section}
            demoCounts={demoCounts}
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
            section={section}
            sort={sort}
            onSort={cycleSort}
            hrefFor={hrefFor}
            onOpen={openLead}
            // What the rows *are*, not what they contain: the page, the size
            // and the criteria. `lastCriteria` already encodes the tab, the
            // applied filters, the sort and the date.
            datasetKey={`${lastCriteria}|${meta.page}|${meta.pageSize}`}
            recordings={recordings}
            onRecordingSaved={handleRecordingSaved}
            demos={demos}
            onDemoSaved={handleDemoSaved}
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

      {/*
       * The lead, as a window over this screen.
       *
       * Rendered here, inside the worklist, and that placement is the feature:
       * everything above stays mounted while it is open, so closing it does not
       * restore the page, the search, the filters, the tab and the scroll
       * position — it simply stops covering them.
       *
       * `AnimatePresence` is only for the way out. Without it the window would
       * vanish on the frame it is closed, which after a 200ms entrance reads as
       * a crash rather than a dismissal.
       */}
      <AnimatePresence>
        {open && (
          <LeadOverlay
            key="lead-overlay"
            leadId={open.id}
            leadName={open.name}
            positionLabel={`${leadPosition(meta.page, meta.pageSize, open.index)} of ${meta.total}`}
            section={section}
            serverToday={today}
            onDemoSaved={handleDemoSaved}
            onClose={closeLead}
            onPrev={hasPrev ? goPrev : null}
            onNext={hasNext ? goNext : null}
            onSaved={handleSaved}
          />
        )}
      </AnimatePresence>
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
