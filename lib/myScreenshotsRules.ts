import { todayIso } from "./leadUtils";
import { addDays } from "./performanceRules";
import { parseTimeOfDay } from "./screenshotViewerRules";

/**
 * An agent's own screenshots — the query, the shapes, and no database.
 *
 * ---------------------------------------------------------------------------
 * The one thing this query cannot say
 * ---------------------------------------------------------------------------
 * Compare `ScreenshotQuery` in `screenshotViewerRules.ts`, the administrator's.
 * It carries a `userId`, read from `?agent=`, because pointing the viewer at a
 * person is the whole job of that screen.
 *
 * There is no `userId` on the query below and there must never be one. Every
 * field here narrows a read whose subject has already been decided by the
 * session row and passed in beside it (`lib/myScreenshots.ts`), so a filter is
 * only ever a way of seeing *less* of your own list. That is what makes it safe
 * for all of them to be arbitrary strings from the URL, and it is why they are
 * clamped rather than rejected — a gallery should not 400 somebody over a stale
 * bookmark.
 *
 * `workSessionId` is the one worth saying out loud. It is an id the client
 * supplies, and it is ANDed with the session's own user id rather than
 * consulted about whose shift it is: another agent's shift id selects rows that
 * are both theirs and yours, of which there are none. It narrows to nothing
 * instead of widening to somebody, which is the property that makes it a filter
 * and not a lookup.
 *
 * Formatting and time parsing are imported from the admin module rather than
 * copied — pure functions with no policy in them, and two clocks that disagree
 * about how to write a time is a bug waiting for somebody to compare screens.
 */

/* -------------------------------------------------------------------------- */
/* Paging                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The page sizes offered.
 *
 * Not the admin viewer's 25/50/100. This grid is four cards across at its
 * widest, and a page that ends halfway through a row looks like a rendering
 * fault rather than a boundary — so every option here is a whole number of rows
 * at every breakpoint the grid uses.
 */
export const MY_SCREENSHOT_PAGE_SIZES = [24, 48, 96] as const;

export type MyScreenshotPageSize = (typeof MY_SCREENSHOT_PAGE_SIZES)[number];

export const DEFAULT_MY_SCREENSHOT_PAGE_SIZE: MyScreenshotPageSize = 24;

export function readMyScreenshotPage(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * A page size, or the default.
 *
 * Membership of the list, not a `Math.min`. A caller asking for 100,000 does
 * not get 96 because 96 is the ceiling; they get 24 because 100,000 was never
 * one of the sizes this screen offers. "Do not fetch every screenshot at once"
 * is therefore a property of the endpoint rather than of the component that
 * happens to call it.
 */
export function readMyScreenshotPageSize(
  value: string | null | undefined,
): MyScreenshotPageSize {
  const parsed = Number(value);
  return (MY_SCREENSHOT_PAGE_SIZES as readonly number[]).includes(parsed)
    ? (parsed as MyScreenshotPageSize)
    : DEFAULT_MY_SCREENSHOT_PAGE_SIZE;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The date presets, and why there is an "all" the admin screen does not have.
 *
 * That screen is a monitoring console: an administrator arrives asking "what is
 * happening today", and a day is the right default and the right unit. This one
 * is somebody's own record, and the question it is opened with is at least as
 * often "what did I do last Tuesday" or simply "let me scroll back". Forcing a
 * day would mean an agent could never look at their history without already
 * knowing the date they wanted, so the whole list is the default and the day is
 * a way of narrowing it.
 */
export const MY_DATE_PRESETS = ["all", "today", "yesterday", "custom"] as const;

export type MyDatePreset = (typeof MY_DATE_PRESETS)[number];

export const MY_DATE_PRESET_LABELS: Record<MyDatePreset, string> = {
  all: "All dates",
  today: "Today",
  yesterday: "Yesterday",
  custom: "Custom date",
};

export interface MyScreenshotQuery {
  preset: MyDatePreset;
  /** The day a preset resolves to. Ignored entirely when the preset is "all". */
  day: string;
  /** One of the caller's own shifts, or null. Narrows; never widens. */
  workSessionId: string | null;
  /**
   * Minutes past midnight. Only meaningful within a single day, so both are
   * forced to null on the "all" preset — see {@link myScreenshotWindow}.
   */
  fromMinutes: number | null;
  toMinutes: number | null;
  page: number;
  pageSize: MyScreenshotPageSize;
}

export const ALL = "all";

function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * An id from the URL, or null.
 *
 * The character class is the admin viewer's, and it is hygiene rather than
 * security: the value reaches Postgres as a bound parameter compared for
 * equality against a column, and a row that matches it still has to be the
 * caller's own to be returned. Nothing here is load-bearing — see the note at
 * the top of this file.
 */
function safeId(value: string | null | undefined): string | null {
  if (!value || value === ALL) return null;
  return /^[a-z0-9]{1,64}$/i.test(value) ? value : null;
}

export function resolveMyScreenshotQuery(
  params: URLSearchParams,
  today = todayIso(),
): MyScreenshotQuery {
  const rawPreset = params.get("date");
  const preset: MyDatePreset = (MY_DATE_PRESETS as readonly string[]).includes(
    rawPreset ?? "",
  )
    ? (rawPreset as MyDatePreset)
    : "all";

  let day = today;
  if (preset === "yesterday") {
    day = addDays(today, -1);
  } else if (preset === "custom") {
    const candidate = params.get("day");
    day = isIsoDay(candidate) ? candidate : today;
  }

  let fromMinutes = parseTimeOfDay(params.get("from"));
  let toMinutes = parseTimeOfDay(params.get("to"));

  if (preset === "all") {
    // A time of day across an unbounded range of days is a question this query
    // cannot ask — it would need the hour extracted from the column rather than
    // a range over it. Dropped rather than silently applied to one arbitrary
    // day, and the control is disabled in the UI so it is never offered.
    fromMinutes = null;
    toMinutes = null;
  } else if (fromMinutes !== null && toMinutes !== null) {
    if (fromMinutes > toMinutes) {
      [fromMinutes, toMinutes] = [toMinutes, fromMinutes];
    } else if (fromMinutes === toMinutes) {
      // An empty window is never what somebody meant, and showing them nothing
      // is a worse answer than showing them the day.
      fromMinutes = null;
      toMinutes = null;
    }
  }

  return {
    preset,
    day,
    workSessionId: safeId(params.get("session")),
    fromMinutes,
    toMinutes,
    page: readMyScreenshotPage(params.get("page")),
    pageSize: readMyScreenshotPageSize(params.get("pageSize")),
  };
}

export function defaultMyScreenshotQuery(today = todayIso()): MyScreenshotQuery {
  return resolveMyScreenshotQuery(new URLSearchParams(), today);
}

/**
 * The instants a query covers, or null for "everything".
 *
 * Null rather than a very wide range on purpose: a `gte`/`lt` pair around the
 * epoch and some far future date would work, but it would also put a range
 * predicate on `captured_at` where none is wanted and stop the planner using
 * `@@index([userId, capturedAt])` as the plain ordered read it is.
 */
export function myScreenshotWindow(
  query: MyScreenshotQuery,
): { from: Date; to: Date } | null {
  if (query.preset === "all") return null;

  const dayStart = startOfDay(query.day);
  const nextDay = startOfDay(addDays(query.day, 1));

  return {
    from:
      query.fromMinutes === null
        ? dayStart
        : new Date(dayStart.getTime() + query.fromMinutes * 60_000),
    to:
      query.toMinutes === null
        ? nextDay
        : new Date(dayStart.getTime() + query.toMinutes * 60_000),
  };
}

function startOfDay(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

/** The query as a query string, for the address bar and for `fetch`. */
export function buildMyScreenshotParams(query: MyScreenshotQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.preset !== "all") params.set("date", query.preset);
  if (query.preset === "custom") params.set("day", query.day);
  if (query.workSessionId) params.set("session", query.workSessionId);
  if (query.fromMinutes !== null) params.set("from", clock(query.fromMinutes));
  if (query.toMinutes !== null) params.set("to", clock(query.toMinutes));
  if (query.page > 1) params.set("page", String(query.page));
  if (query.pageSize !== DEFAULT_MY_SCREENSHOT_PAGE_SIZE) {
    params.set("pageSize", String(query.pageSize));
  }

  return params;
}

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* What crosses to the browser                                                */
/* -------------------------------------------------------------------------- */

/**
 * One card in the agent's own gallery.
 *
 * Compare `ScreenshotCard` in `screenshotViewerRules.ts`, which carries an
 * `agent: { id, name }`. There is no agent on this one, and its absence is the
 * point: every row in this payload belongs to the person reading it, so a name
 * would be either their own — noise — or evidence that the scoping had failed.
 *
 * No `storageKey`, for the reason the admin card has none: the column is not
 * selected by the query that builds this, so there is no filesystem detail in
 * the response, in the browser's memory, or in anything the browser might later
 * send somewhere.
 */
export interface MyScreenshotCard {
  id: string;
  capturedAt: string;
  width: number;
  height: number;
  fileSize: number;
  /** The shift it was taken during. Times only — no id is needed to draw it. */
  workSession: { startedAt: string; endedAt: string | null } | null;
  /**
   * The server's activity figure for the minute this capture falls in, when one
   * was recorded. Null is common and honest: activity is reported on its own
   * cadence and a capture can land in a minute that has no interval.
   *
   * It is a share of a configured events rate and it is not a productivity
   * score — see `lib/activityRules.ts`.
   */
  activityPercentage: number | null;
}

/** One of the caller's own shifts, for the picker. */
export interface MyWorkSessionOption {
  id: string;
  startedAt: string;
  endedAt: string | null;
  screenshotCount: number;
}

export interface MyScreenshotPageMeta {
  page: number;
  pageSize: MyScreenshotPageSize;
  /** Rows matching the current filters, not the size of the table. */
  total: number;
  totalPages: number;
}

export interface MyScreenshotPayload {
  screenshots: MyScreenshotCard[];
  meta: MyScreenshotPageMeta;
  /** The caller's own shifts that the current date filter can reach. */
  sessions: MyWorkSessionOption[];
}
