import {
  CALLBACK_RANGE_LABELS,
  EMPTY_FILTERS,
  type CallbackRange,
  type LeadFilters,
} from "./filters";
import { CALL_STATUSES, type CallStatus } from "./types";
import { WORKLIST_VIEWS, type WorklistView } from "./views";

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

/** Everything needed to answer "give me the rows for this screen". */
export interface LeadPageQuery {
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

  if (view !== "all") params.set("view", view);

  const text = filters.query.trim();
  if (text) params.set("q", text.slice(0, MAX_QUERY_LENGTH));

  for (const status of filters.statuses) params.append("status", status);
  for (const category of filters.categories) params.append("category", category);

  if (filters.ratingMin !== null) params.set("ratingMin", String(filters.ratingMin));
  if (filters.ratingMax !== null) params.set("ratingMax", String(filters.ratingMax));

  if (filters.callback !== "all") params.set("callback", filters.callback);
  if (filters.callback === "custom") {
    if (filters.callbackFrom) params.set("callbackFrom", filters.callbackFrom);
    if (filters.callbackTo) params.set("callbackTo", filters.callbackTo);
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

  // Blank strings dropped: `?category=` is not a request for the leads whose
  // category is the empty string, it is a stray separator.
  const categories = params.getAll("category").filter((value) => value.trim() !== "");

  const callback = readOneOf(params.get("callback"), CALLBACK_RANGES, "all");
  const callbackFrom = params.get("callbackFrom");
  const callbackTo = params.get("callbackTo");

  const filters: LeadFilters = {
    ...EMPTY_FILTERS,
    query: (params.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
    statuses,
    categories,
    ratingMin: readRating(params.get("ratingMin")),
    ratingMax: readRating(params.get("ratingMax")),
    callback,
    callbackFrom: isIsoDate(callbackFrom) ? callbackFrom : null,
    callbackTo: isIsoDate(callbackTo) ? callbackTo : null,
  };

  const today = params.get("today");

  return {
    view: readOneOf(params.get("view"), WORKLIST_VIEWS, "all"),
    filters,
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
