import { todayIso } from "./leadUtils";
import { addDays } from "./performanceRules";

/**
 * What the screenshot viewer may be asked for, and nothing more.
 *
 * The pure half of the feature: parsing a query string into a filter, turning a
 * filter back into a query string, and the formatting both the server and the
 * browser need to agree on. No Prisma, no `next/headers`, no filesystem — same
 * split as `performanceRules.ts` against `performance.ts`, and for the same
 * reason: this module is imported by a client component, so it must carry no
 * runtime with it.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a permission
 * ---------------------------------------------------------------------------
 * Every value in a {@link ScreenshotQuery} is a *filter* — it narrows a read
 * that has already been authorized by `apiAdmin()` against the session row in
 * Postgres. `userId` in particular is the agent whose screenshots are being
 * looked at, never a claim about who is looking; the caller's identity is not
 * in the query string at all and could not be put there.
 *
 * That is what makes it safe for these to be arbitrary strings off the wire.
 * The worst a hostile value can do is match no rows, which is why the parsing
 * below clamps and falls back rather than rejecting — the same decision
 * `resolveRange` made, and for the same reason: a monitoring screen should not
 * 400 an administrator over a stale bookmark.
 */

/**
 * Rows per page.
 *
 * Deliberately not the worklist's `PAGE_SIZES` (10/20/50/100). A screenshot
 * card is roughly twenty times the area of a table row, so ten of them is half
 * a screen of scrolling for nothing, and the useful floor is higher. Fifty is
 * the default because it is about a day's captures for a small team at the
 * 10–30 minute interval the scheduler actually runs at.
 */
export const SCREENSHOT_PAGE_SIZES = [25, 50, 100] as const;

export type ScreenshotPageSize = (typeof SCREENSHOT_PAGE_SIZES)[number];

export const DEFAULT_SCREENSHOT_PAGE_SIZE: ScreenshotPageSize = 50;

/**
 * A cap on how many capture *times* the timeline strip may plot.
 *
 * The strip needs every capture in the window, not just the current page — its
 * whole job is to show the shape of a day that pagination has cut into pieces.
 * That is a second, unpaged read, so it gets a ceiling: at a 10-minute floor a
 * single agent-day is under 150 points and a ten-agent day is under 1500, so
 * 2000 covers every real case and still refuses to stream a year of rows into a
 * browser if somebody widens the window in a way this design did not anticipate.
 */
export const TIMELINE_POINT_LIMIT = 2000;

/** Which day is being looked at. A single day — not a range. */
export const DATE_PRESETS = ["today", "yesterday", "custom"] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  custom: "Custom date",
};

/** The whole filter, resolved and safe to hand to a query builder. */
export interface ScreenshotQuery {
  preset: DatePreset;
  /** The day being viewed, `YYYY-MM-DD`, in the server's timezone. */
  day: string;
  /** One agent, or null for everybody. A filter — never an authorization. */
  userId: string | null;
  /** One shift, or null for all of them. */
  workSessionId: string | null;
  /** Minutes since local midnight. Both null when no time filter is set. */
  fromMinutes: number | null;
  toMinutes: number | null;
  page: number;
  pageSize: ScreenshotPageSize;
}

/** The half-open instant window a {@link ScreenshotQuery} covers. */
export interface ScreenshotWindow {
  /** Inclusive start. */
  from: Date;
  /** Exclusive end — see {@link screenshotWindow}. */
  to: Date;
}

export const ALL = "all";

/** Local midnight at the start of `YYYY-MM-DD`. */
function startOfDay(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * A cuid, or nothing.
 *
 * Not a security check — an id from a query string is only ever a filter, and
 * an unrecognised one would simply match no rows. It is here to keep a typo or
 * a truncated URL from becoming a database round trip, and to keep the value
 * that reaches Prisma a shape this application actually mints.
 */
function safeId(value: string | null | undefined): string | null {
  if (!value || value === ALL) return null;
  return /^[a-z0-9]{1,64}$/i.test(value) ? value : null;
}

/** `HH:MM` as minutes since midnight, or null. */
export function parseTimeOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** Minutes since midnight as `HH:MM`, for putting back in a time input. */
export function formatTimeOfDay(minutes: number | null): string {
  if (minutes === null) return "";
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function readScreenshotPage(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function readScreenshotPageSize(
  value: string | null | undefined,
): ScreenshotPageSize {
  const parsed = Number(value);
  return (SCREENSHOT_PAGE_SIZES as readonly number[]).includes(parsed)
    ? (parsed as ScreenshotPageSize)
    : DEFAULT_SCREENSHOT_PAGE_SIZE;
}

/**
 * Turn a query string into a filter.
 *
 * Everything is clamped rather than rejected, which is what makes this safe to
 * run directly on `request.url`:
 *
 *   - an unknown preset is "today", which is also the default view;
 *   - a malformed custom day falls back to today;
 *   - a future day is left alone (it simply has no screenshots) but a day
 *     before the epoch of this feature is not special-cased either — the query
 *     is bounded by the day, so an absurd one is a cheap empty result;
 *   - a reversed time pair is swapped, because somebody picked the second
 *     field first;
 *   - a zero-width time pair is dropped entirely. `09:00 → 09:00` cannot be a
 *     request for the screenshots captured in no time at all, so it is read as
 *     an unfinished edit rather than obeyed into an empty screen.
 */
export function resolveScreenshotQuery(
  params: URLSearchParams,
  today = todayIso(),
): ScreenshotQuery {
  const rawPreset = params.get("date");
  const preset: DatePreset = (DATE_PRESETS as readonly string[]).includes(rawPreset ?? "")
    ? (rawPreset as DatePreset)
    : "today";

  let day = today;
  if (preset === "yesterday") {
    day = addDays(today, -1);
  } else if (preset === "custom") {
    const candidate = params.get("day");
    day = isIsoDay(candidate) ? candidate : today;
  }

  let fromMinutes = parseTimeOfDay(params.get("from"));
  let toMinutes = parseTimeOfDay(params.get("to"));

  if (fromMinutes !== null && toMinutes !== null) {
    if (fromMinutes > toMinutes) {
      [fromMinutes, toMinutes] = [toMinutes, fromMinutes];
    } else if (fromMinutes === toMinutes) {
      fromMinutes = null;
      toMinutes = null;
    }
  }

  return {
    preset,
    day,
    userId: safeId(params.get("agent")),
    workSessionId: safeId(params.get("session")),
    fromMinutes,
    toMinutes,
    page: readScreenshotPage(params.get("page")),
    pageSize: readScreenshotPageSize(params.get("pageSize")),
  };
}

/**
 * The instants a filter covers, half-open.
 *
 * `[from, to)` throughout, for the reason `resolveRange` gives: a closed upper
 * bound either drops whatever was captured in the last millisecond of the
 * window or double-counts the boundary between two adjacent ones.
 *
 * With no time filter the window is the whole local day. With one it is the
 * stated minutes — and the *end* minute is exclusive, so `09:00 → 17:00` is a
 * shift that ends at five, not one that reaches a second into 17:00.
 */
export function screenshotWindow(query: ScreenshotQuery): ScreenshotWindow {
  const dayStart = startOfDay(query.day);
  const nextDay = startOfDay(addDays(query.day, 1));

  const from =
    query.fromMinutes === null
      ? dayStart
      : new Date(dayStart.getTime() + query.fromMinutes * 60_000);

  const to =
    query.toMinutes === null
      ? nextDay
      : new Date(dayStart.getTime() + query.toMinutes * 60_000);

  return { from, to };
}

/** The filter as a query string, so the browser and the server build one URL. */
export function buildScreenshotSearchParams(query: ScreenshotQuery): URLSearchParams {
  const params = new URLSearchParams();

  params.set("date", query.preset);
  if (query.preset === "custom") params.set("day", query.day);
  if (query.userId) params.set("agent", query.userId);
  if (query.workSessionId) params.set("session", query.workSessionId);
  if (query.fromMinutes !== null) params.set("from", formatTimeOfDay(query.fromMinutes));
  if (query.toMinutes !== null) params.set("to", formatTimeOfDay(query.toMinutes));
  if (query.page > 1) params.set("page", String(query.page));
  if (query.pageSize !== DEFAULT_SCREENSHOT_PAGE_SIZE) {
    params.set("pageSize", String(query.pageSize));
  }

  return params;
}

/** The filter every screen opens on: today, everyone, all day, page one. */
export function defaultScreenshotQuery(today = todayIso()): ScreenshotQuery {
  return resolveScreenshotQuery(new URLSearchParams(), today);
}

/* -------------------------------------------------------------------------- */
/* What crosses to the browser                                                */
/* -------------------------------------------------------------------------- */

/**
 * One screenshot, as the viewer sees it.
 *
 * **No `storageKey` and no path.** The browser is given an id and asks for the
 * bytes by it; where the file actually lives is a server-side detail that this
 * shape is deliberately unable to express. Adding the column here would leak
 * the storage layout into every response and into the browser's memory, for a
 * value nothing on the client could do anything with.
 */
export interface ScreenshotCard {
  id: string;
  /** ISO instant. Formatting is the browser's, so it is in the reader's zone. */
  capturedAt: string;
  width: number;
  height: number;
  fileSize: number;
  agent: { id: string; name: string };
  /** Null only if the shift row has gone, which the schema does not allow. */
  workSession: WorkSessionSummary | null;
}

/** A shift, for the picker and for the context line in the detail view. */
export interface WorkSessionSummary {
  id: string;
  startedAt: string;
  /** Null while the shift is still open. */
  endedAt: string | null;
  /** How many screenshots fall inside it, when the picker asked for counts. */
  screenshotCount?: number;
}

/** The small metrics above the gallery. Every one is counted, never estimated. */
export interface ScreenshotSummary {
  /** Captures in the selected window — the heading says which. */
  inWindow: number;
  /** Distinct agents with a capture in the window. */
  activeAgents: number;
  /** The newest capture in the window, or null when there is none. */
  latestCaptureAt: string | null;
}

export interface ScreenshotPageMeta {
  page: number;
  pageSize: ScreenshotPageSize;
  total: number;
  totalPages: number;
}

/** One dot on the timeline strip. */
export interface TimelinePoint {
  id: string;
  capturedAt: string;
  agentId: string;
}

/** Everything one filter produces, in one response. */
export interface ScreenshotPayload {
  screenshots: ScreenshotCard[];
  meta: ScreenshotPageMeta;
  summary: ScreenshotSummary;
  timeline: TimelinePoint[];
  /** True when the timeline hit {@link TIMELINE_POINT_LIMIT} and is partial. */
  timelineTruncated: boolean;
  /** The shifts that overlap the selected day, for the session picker. */
  sessions: WorkSessionSummary[];
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** `14:32:18`, in the reader's timezone. */
export function formatClock(iso: string, withSeconds = true): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

/** "Today", "Yesterday", or a written date — relative to the reader's day. */
export function formatDayLabel(iso: string, today: string): string {
  const day = new Date(iso);
  const dayIso = localDayIso(day);

  if (dayIso === today) return "Today";
  if (dayIso === addDays(today, -1)) return "Yesterday";

  return day.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** A Date as `YYYY-MM-DD` in the local zone. The inverse of `startOfDay`. */
export function localDayIso(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

/** `1.4 MB`. Base ten, because that is what a file manager shows. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}

/**
 * A shift as `09:04 – 17:32`, or `09:04 – now` while it is still open.
 *
 * "now" rather than a blank or a guess: an open session has no end, and writing
 * one would be inventing the session information the brief forbids inventing.
 */
export function formatWorkSessionSpan(session: WorkSessionSummary): string {
  const started = formatClock(session.startedAt, false);
  return session.endedAt
    ? `${started} – ${formatClock(session.endedAt, false)}`
    : `${started} – now`;
}
