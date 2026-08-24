import {
  CALLBACK_RANGE_LABELS,
  DEMO_FILTERS,
  EMPTY_FILTERS,
  type CallbackRange,
  type DemoFilter,
  type LeadFilters,
} from "./filters";
import { CALL_STATUSES, LEAD_SOURCES, type CallStatus, type LeadSource } from "./types";
import { WORKLIST_VIEWS, type WorklistView } from "./views";
import {
  DEFAULT_WORK_STATE,
  LEAD_WORK_STATES,
  type LeadWorkState,
} from "./workState";

/**
 * One description of "which slice of the worklist am I looking at", shared by
 * the browser that asks for it and the route handler that answers.
 *
 * The worklist used to hold every lead in React state and narrow it with
 * `isInView` + `matchesFilters` on each render, so the tab, the filters and the
 * page never had to be *named* anywhere — they were just closures over an
 * array. Now that the rows come a page at a time, the same three things have to
 * survive a trip through a URL, and both ends have to agree on exactly what
 * they mean. That agreement is this file: `buildLeadSearchParams` writes it and
 * `parseLeadSearchParams` reads it, so a param can never be spelled one way by
 * the client and another by the server.
 *
 * No Prisma and no React here on purpose — it is imported by a client
 * component, a server component and a route handler alike.
 *
 * `parseLeadSearchParams` treats its input as hostile. It is reached from a
 * query string, so every value is validated against the same closed sets the UI
 * offers rather than being passed through: an unknown status is dropped, not
 * queried for, and `pageSize` can only ever be one of the four sizes below —
 * `?pageSize=100000` is not a way to ask for the whole table back.
 */

/**
 * Which of the two views is asking.
 *
 * The worklist and Demo Websites are the *same query over the same leads* —
 * same filters, same search, same sort, same pager — differing only in what the
 * screen draws beside each row and which module grants access to it. So this is
 * a parameter of the lead query rather than a second query: `section=demo` asks
 * the same endpoint for the same page and adds the demo metadata for those rows
 * to the response.
 *
 * It is also the one value in this file that is a *permission* input as well as
 * a display one. `GET /api/leads` picks its guard from it — `leads` for the
 * worklist, `demoWebsites` for the demo view — so an agent granted one module
 * and not the other is refused the section they may not have. Which is safe
 * precisely because it is checked server-side against the `users` row: naming a
 * section in a query string asks a question, it does not answer one.
 */
export const LEAD_SECTIONS = ["leads", "demo"] as const;

export type LeadSection = (typeof LEAD_SECTIONS)[number];

export const DEFAULT_LEAD_SECTION: LeadSection = "leads";

/** The page sizes the selector offers. Nothing else is accepted. */
export const PAGE_SIZES = [10, 20, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

/**
 * 20 rows: enough that an agent works a screenful between clicks, few enough
 * that the eight-column table still fits a laptop without scrolling twice.
 */
export const DEFAULT_PAGE_SIZE: PageSize = 20;

/**
 * A search box is a search box, not a payload. The longest thing anyone types
 * here is an address; the cap exists so a megabyte of text cannot be turned
 * into a megabyte `LIKE` pattern against every row.
 */
const MAX_QUERY_LENGTH = 200;

const CALLBACK_RANGES = Object.keys(CALLBACK_RANGE_LABELS) as CallbackRange[];

/**
 * The columns a header click can sort by, plus `default` for the order the
 * table has always had (insertion order — see `listLeads`).
 *
 * A closed set, not a column name passed through from the browser: this value
 * ends up inside an `ORDER BY`, which is the one part of the worklist query
 * that cannot be a bound parameter. Nothing outside this list ever reaches SQL
 * — `leadOrderSql` maps each key to an expression it holds itself.
 *
 * Only the four scraped columns an agent scans by are here. The working columns
 * are deliberately absent: sorting by status or callback would reshuffle rows
 * *as they are edited*, which is exactly when an agent needs the list to hold
 * still — that is what the tabs and the filter rail are for.
 */
export const LEAD_SORT_KEYS = ["default", "name", "phone", "address", "category"] as const;

export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** How the table is currently ordered. `default` ignores `direction`. */
export interface LeadSort {
  key: LeadSortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: LeadSort = { key: "default", direction: "asc" };

/** Everything needed to answer "give me the rows for this screen". */
export interface LeadPageQuery {
  /**
   * Which view is asking. Does not change *which* leads match — the filters do
   * that, and they are identical in both — only what travels back beside them
   * and which module the endpoint demands.
   */
  section: LeadSection;
  /**
   * Which queue: never-called leads, or ones already worked. The outermost
   * narrowing, applied before the view and the filters — see `lib/workState.ts`.
   */
  workState: LeadWorkState;
  /** The worklist tab — the *scope* being worked. */
  view: WorklistView;
  /** The filter rail's narrowing *within* that scope. */
  filters: LeadFilters;
  /**
   * The agent's own `YYYY-MM-DD`. Sent rather than assumed: "overdue" and "due
   * today" are relative to the person reading the screen, and a server in
   * another timezone would quietly shift both.
   */
  today: string;
  /**
   * Which column the table is ordered by. Part of the query rather than of the
   * client, because the client only holds one page: sorting the twenty rows in
   * the browser would order the page instead of the list, and page 2 would
   * still be whatever page 2 was before the click.
   */
  sort: LeadSort;
  /** 1-based. Clamped to the last page by the query, never by the caller. */
  page: number;
  pageSize: PageSize;
}

/** What the worklist gets back for one page. */
export interface LeadPageMeta {
  page: number;
  pageSize: number;
  /** Rows matching the tab *and* the filters — not the size of the table. */
  total: number;
  totalPages: number;
}

// --- writing ----------------------------------------------------------------

/**
 * The query as a `URLSearchParams`.
 *
 * Defaults are omitted, so an untouched worklist asks for `?today=…` and little
 * else. That keeps the request legible in a network panel and means two
 * equivalent states produce one identical string — which is what lets the
 * worklist skip a fetch it has already made.
 */
export function buildLeadSearchParams(query: LeadPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  const { view, filters } = query;

  // Omitted for the worklist, like every other default here — so the ordinary
  // lead query is byte-for-byte the string it has always been, and the screen
  // that was handed its first page still recognises it and skips the fetch.
  if (query.section !== DEFAULT_LEAD_SECTION) params.set("section", query.section);

  // Omitted when it is the default, like every other param here — and the
  // default is New, so the queue an agent lands on asks for nothing extra.
  if (query.workState !== DEFAULT_WORK_STATE) params.set("work", query.workState);

  if (view !== "all") params.set("view", view);

  const text = filters.query.trim();
  if (text) params.set("q", text.slice(0, MAX_QUERY_LENGTH));

  for (const status of filters.statuses) params.append("status", status);
  // Repeated, like `status` and `category`: the three are multi-select lists
  // and a comma-joined value would have to be split back apart by a second
  // convention that could disagree with this one.
  for (const source of filters.sources) params.append("source", source);
  for (const category of filters.categories) params.append("category", category);

  if (filters.ratingMin !== null) params.set("ratingMin", String(filters.ratingMin));
  if (filters.ratingMax !== null) params.set("ratingMax", String(filters.ratingMax));

  // Demo content. Written whatever the section — the demo view is the only
  // thing that sets it, and a URL it produced must survive a copy-paste.
  if (filters.demo !== "all") params.set("demo", filters.demo);

  if (filters.callback !== "all") params.set("callback", filters.callback);
  if (filters.callback === "custom") {
    if (filters.callbackFrom) params.set("callbackFrom", filters.callbackFrom);
    if (filters.callbackTo) params.set("callbackTo", filters.callbackTo);
  }

  // `default` is the absence of a sort, so it is written as an absent param —
  // which keeps an untouched worklist producing the same string it always did,
  // and therefore still skipping the fetch for the page it was handed.
  if (query.sort.key !== "default") {
    params.set("sort", query.sort.key);
    params.set("dir", query.sort.direction);
  }

  params.set("today", query.today);
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));

  return params;
}

// --- reading ----------------------------------------------------------------

/** `YYYY-MM-DD` and nothing else — this string reaches a date comparison. */
function isIsoDate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** A finite number inside the rating scale, or null. */
function readRating(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(5, Math.max(0, parsed));
}

function readOneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * A query string as a validated {@link LeadPageQuery}.
 *
 * `fallbackToday` is used when the caller sent no `today` (or nonsense) — the
 * server's own date, which is right for a bare `GET /api/leads` and harmless
 * for the worklist, which always sends its own.
 */
export function parseLeadSearchParams(
  params: URLSearchParams,
  fallbackToday: string,
): LeadPageQuery {
  const statuses = params
    .getAll("status")
    .filter((value): value is CallStatus =>
      (CALL_STATUSES as readonly string[]).includes(value),
    );

  // Same closed-set treatment as `status`: an unrecognised `?source=facebook`
  // is dropped rather than queried for, so a hand-edited URL cannot ask the
  // database about a directory that does not exist.
  const sources = params
    .getAll("source")
    .filter((value): value is LeadSource =>
      (LEAD_SOURCES as readonly string[]).includes(value),
    );

  // Blank strings dropped: `?category=` is not a request for the leads whose
  // category is the empty string, it is a stray separator.
  const categories = params.getAll("category").filter((value) => value.trim() !== "");

  const section = readOneOf(params.get("section"), LEAD_SECTIONS, DEFAULT_LEAD_SECTION);

  /*
   * The demo filter is read only in the demo section.
   *
   * It is a join onto `demo_websites`, and the worklist neither offers it nor
   * draws a chip for it — so a hand-edited `/?demo=none` would silently narrow
   * that screen with nothing on it to say why or to clear it. Ignoring the
   * parameter there keeps the worklist exactly the screen it was.
   */
  const demo: DemoFilter =
    section === "demo" ? readOneOf(params.get("demo"), DEMO_FILTERS, "all") : "all";

  const callback = readOneOf(params.get("callback"), CALLBACK_RANGES, "all");
  const callbackFrom = params.get("callbackFrom");
  const callbackTo = params.get("callbackTo");

  const filters: LeadFilters = {
    ...EMPTY_FILTERS,
    query: (params.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
    statuses,
    sources,
    categories,
    ratingMin: readRating(params.get("ratingMin")),
    ratingMax: readRating(params.get("ratingMax")),
    callback,
    callbackFrom: isIsoDate(callbackFrom) ? callbackFrom : null,
    callbackTo: isIsoDate(callbackTo) ? callbackTo : null,
    demo,
  };

  const today = params.get("today");

  return {
    section,
    workState: readOneOf(params.get("work"), LEAD_WORK_STATES, DEFAULT_WORK_STATE),
    view: readOneOf(params.get("view"), WORKLIST_VIEWS, "all"),
    filters,
    sort: {
      key: readOneOf(params.get("sort"), LEAD_SORT_KEYS, "default"),
      direction: readOneOf(params.get("dir"), SORT_DIRECTIONS, "asc"),
    },
    today: isIsoDate(today) ? today : fallbackToday,
    page: readPage(params.get("page")),
    pageSize: readPageSize(params.get("pageSize")),
  };
}

/** 1-based, integral, and at least 1. The upper end is clamped by the query. */
export function readPage(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
}

/** One of {@link PAGE_SIZES}, or the default. Never a caller-chosen number. */
export function readPageSize(value: string | null | undefined): PageSize {
  const parsed = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(parsed)
    ? (parsed as PageSize)
    : DEFAULT_PAGE_SIZE;
}
