import type { Role } from "./access";
import { todayIso } from "./leadUtils";

/**
 * The vocabulary of performance reporting: the shapes, the date presets, the
 * derived rates and the two clock formats.
 *
 * **No Prisma here, and that is the whole point of the file.** The screens that
 * draw these numbers are client components, and a client component importing
 * anything that reaches `lib/prisma.ts` drags the Postgres driver into the
 * browser bundle — which fails the build, and would be a bad idea if it did
 * not. So the queries live in `lib/performance.ts` and the language they speak
 * lives here, where a report panel, a route handler and a server page can all
 * import it. Exactly the split `lib/recordingRules.ts` has from
 * `lib/recordings.ts`, and `lib/workState.ts` from `lib/leadDb.ts`.
 *
 * Everything below is pure: no I/O, no clock except the one passed in, nothing
 * that behaves differently on the server than in the browser.
 */

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

export const RANGE_KEYS = ["today", "yesterday", "last7", "last30", "custom"] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

export const RANGE_LABELS: Record<RangeKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  custom: "Custom range",
};

export interface DateRange {
  /** Inclusive start instant — local midnight of the first day. */
  from: Date;
  /** Exclusive end instant — local midnight after the last day. */
  to: Date;
  /** First and last day as `YYYY-MM-DD`, for labelling and for the day series. */
  fromDay: string;
  toDay: string;
  key: RangeKey;
  label: string;
  /** Whole days covered, at least 1. Used for per-day averages. */
  days: number;
}

/** Local midnight at the start of `YYYY-MM-DD`. */
function startOfDay(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

export function addDays(iso: string, delta: number): string {
  const date = startOfDay(iso);
  date.setDate(date.getDate() + delta);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Turn a preset (or a pair of dates) into a half-open instant range.
 *
 * Days are the *server's* days, the same ones `todayIso()` produces for the
 * worklist's callback highlighting — so "today" means the same thing on the
 * report as it does on the call list, which is the only way the two can be read
 * side by side.
 *
 * Half-open `[from, to)` throughout: a closed upper bound would either drop
 * everything saved in the last millisecond of a day or double-count the
 * boundary between two adjacent ranges.
 *
 * Bad input is clamped rather than rejected. A custom range with the dates the
 * wrong way round is somebody who picked the second date first, and swapping
 * them is what they meant; a missing or malformed one falls back to today. A
 * report is not a place to fail a request over a typo in a date picker — and
 * because this is what the API route runs on the query string, that is also
 * what makes `?range=<anything>` safe rather than something to validate twice.
 */
export function resolveRange(
  key: string | null | undefined,
  fromParam?: string | null,
  toParam?: string | null,
  today = todayIso(),
): DateRange {
  const rangeKey: RangeKey = (RANGE_KEYS as readonly string[]).includes(key ?? "")
    ? (key as RangeKey)
    : "today";

  let fromDay = today;
  let toDay = today;

  switch (rangeKey) {
    case "yesterday":
      fromDay = addDays(today, -1);
      toDay = fromDay;
      break;
    case "last7":
      // Seven days *including* today, which is what someone reading "last 7
      // days" beside a "today" total expects the two to be consistent about.
      fromDay = addDays(today, -6);
      toDay = today;
      break;
    case "last30":
      fromDay = addDays(today, -29);
      toDay = today;
      break;
    case "custom": {
      const start = isIsoDay(fromParam) ? fromParam : today;
      const end = isIsoDay(toParam) ? toParam : today;
      fromDay = start <= end ? start : end;
      toDay = start <= end ? end : start;
      break;
    }
    case "today":
    default:
      break;
  }

  const from = startOfDay(fromDay);
  const to = startOfDay(addDays(toDay, 1));
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));

  const label =
    rangeKey === "custom"
      ? fromDay === toDay
        ? fromDay
        : `${fromDay} → ${toDay}`
      : RANGE_LABELS[rangeKey];

  return { from, to, fromDay, toDay, key: rangeKey, label, days };
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * One agent's numbers over one window. Every field is a count of a row that
 * exists because somebody pressed Save.
 */
export interface PerformanceMetrics {
  /** Distinct leads a call outcome was saved against. Not "leads opened". */
  leadsWorked: number;
  /** Call outcomes saved. Higher than `leadsWorked` when a lead is re-worked. */
  calls: number;
  /**
   * Calls where a human actually answered — every outcome except "no answer",
   * "voicemail" and "bad number". This is the honest reading of the statuses
   * the app already has; there is no separate "connected" flag to consult.
   */
  contacts: number;
  /** Calls that ended in "Interested". */
  interested: number;
  /** Calls that ended in a decision either way, and so could have converted. */
  decided: number;
  /** Callbacks put in the diary without a time. */
  callbacks: number;
  /** Meetings booked — a diary date with a time on it. */
  meetingsBooked: number;
  /** Meetings marked done. */
  meetingsCompleted: number;
  /** Seconds signed in *within this window*, clamped at both ends. */
  activeSeconds: number;
}

export const ZERO_METRICS: PerformanceMetrics = {
  leadsWorked: 0,
  calls: 0,
  contacts: 0,
  interested: 0,
  decided: 0,
  callbacks: 0,
  meetingsBooked: 0,
  meetingsCompleted: 0,
  activeSeconds: 0,
};

export interface AgentPerformance extends PerformanceMetrics {
  userId: string;
  name: string;
  username: string;
  role: Role;
  isActive: boolean;
  /** True while one of their work sessions is still running. */
  online: boolean;
}

/** One day of the team's (or one agent's) activity, for the chart. */
export interface ActivityDay {
  /** `YYYY-MM-DD`, every day in the range, including the empty ones. */
  day: string;
  calls: number;
  leadsWorked: number;
  meetings: number;
}

/**
 * One agent's work time over the three windows an administrator actually asks
 * about, plus whatever is running right now.
 *
 * Deliberately **not** driven by the report's date filter. "How long has Ahmed
 * worked today / this week / this month" is a fixed question with fixed
 * windows, and answering it through a control that might be set to "yesterday"
 * would mean the column headings lie. The filtered, range-driven figures are
 * the `activeSeconds` on {@link AgentPerformance}; these three sit apart from
 * them on purpose.
 */
export interface AgentWorkTime {
  userId: string;
  name: string;
  role: Role;
  /** Local midnight to now. */
  todaySeconds: number;
  /** The last 7 days including today. */
  weekSeconds: number;
  /** The last 30 days including today. */
  monthSeconds: number;
  /**
   * When the running session began, or null. The client counts from this so an
   * admin watching the screen sees the same clock the agent does, rather than a
   * figure frozen at whenever the page was loaded.
   */
  currentSessionStartedAt: string | null;
  /**
   * The server instant these sums describe.
   *
   * `todaySeconds` already includes the running session up to *this* moment, so
   * a client that wants a live figure adds the time since `asOf` — never the
   * whole session, which is already in there. Same no-overlap discipline as
   * {@link WorkClock}: the number and its anchor travel together so the
   * addition cannot double-count.
   */
  asOf: string;
}

export interface PerformanceReport {
  range: DateRange;
  agents: AgentPerformance[];
  /**
   * The team as a whole. Not the sum of the rows above for every field:
   * `leadsWorked` is a *distinct* count, and two agents who both called the
   * same lead worked one lead between them, not two.
   */
  totals: PerformanceMetrics;
  daily: ActivityDay[];
  /**
   * Work time over today / this week / this month, per agent. Independent of
   * `range` — see {@link AgentWorkTime} for why those windows are fixed.
   */
  workTime: AgentWorkTime[];
}

/** Today and the last seven days, which is what the agent's own screens show. */
export interface PersonalPerformance {
  today: PerformanceMetrics;
  week: PerformanceMetrics;
  /** The seven days behind the chart on `/my-performance`. */
  daily: ActivityDay[];
  /** The server's today, so the client formats the same day the server counted. */
  todayIso: string;
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

/*
 * There is deliberately no daily target here.
 *
 * An earlier version carried a `DAILY_LEAD_TARGET` constant and drew the
 * agent's leads-worked figure as a progress bar against it. It was removed
 * because it was the only number on these screens that was not counted from the
 * database — a team-wide guess wearing the same typeface as the measurements
 * beside it, which is exactly how a number nobody chose ends up being treated
 * as one somebody did.
 *
 * If a target is wanted later it needs an owner and a place to be set: a column
 * on `users`, or a settings row, edited by an administrator. Until something
 * can answer "who decided 60?", the honest screen is the one that reports what
 * happened and leaves the judgement to the person reading it.
 */

/** Interested outcomes as a share of the leads actually worked. */
export function conversionRate(metrics: PerformanceMetrics): number | null {
  if (metrics.leadsWorked === 0) return null;
  return (metrics.interested / metrics.leadsWorked) * 100;
}

/** Answered calls as a share of calls made. */
export function contactRate(metrics: PerformanceMetrics): number | null {
  if (metrics.calls === 0) return null;
  return (metrics.contacts / metrics.calls) * 100;
}

/**
 * Leads worked per hour signed in.
 *
 * Null below a quarter of an hour rather than zero: dividing four leads by two
 * minutes reports 120 leads an hour, which is not a fast agent, it is a small
 * denominator. A rate needs enough time under it to mean anything.
 */
export function leadsPerHour(metrics: PerformanceMetrics): number | null {
  if (metrics.activeSeconds < 900) return null;
  return metrics.leadsWorked / (metrics.activeSeconds / 3600);
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * How often an open portal tab tells the server it is still there.
 *
 * Read by both ends — the browser sets its interval from it and
 * `lib/workSessions.ts` derives the staleness window from it — so the two can
 * never drift into disagreeing about what a dead session is.
 */
export const HEARTBEAT_SECONDS = 60;

/** `13362` -> `3h 42m`. Zero is "0m", never an empty string. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * `9258` -> `02h 34m` — the work clock as it appears in the shell.
 *
 * Hours and minutes only, zero-padded, and **no seconds**. A figure in the top
 * bar that changes every second is one an agent's eye is dragged back to all
 * day; at a minute's resolution it updates rarely enough to be glanceable and
 * is still precise enough for the only question anyone asks of it. The seconds
 * are on `/my-performance`, which is where somebody goes when they actually
 * want to watch the clock.
 *
 * Zero-padded because these two numbers sit in a row and change width
 * otherwise, which makes the whole bar shuffle sideways on the hour.
 */
export function formatWorkClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

/** `9258` -> `02h 34m 18s`. The same clock with seconds, for the one screen that watches it. */
export function formatWorkClockLong(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${formatWorkClock(seconds)} ${String(seconds % 60).padStart(2, "0")}s`;
}

/** `13362` -> `03:42:42` — the running clock, where every digit is stable. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const parts = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

/**
 * Everything the on-screen clock needs, read from the database in one go.
 *
 * The shape exists to make one class of bug impossible. "Today's total" and
 * "the session running right now" overlap — the open shift is part of both —
 * and any version of this that hands the client two numbers which each already
 * contain the open session will double-count it the moment the client adds them
 * together. So the split here is on a line that cannot overlap:
 *
 *   completedSecondsToday   **closed sessions only**, clamped to today
 *   startedAt               when the open one began, or null
 *
 * The client's sum is then `completed + (now - startedAt)`, and the open
 * session appears in it exactly once, by construction rather than by care.
 *
 * `serverNow` is the third field for a reason the brief is explicit about: the
 * persisted timestamps are the server's, so the *displayed* clock has to be
 * measured against the server's clock too. A workstation whose time is ten
 * minutes fast would otherwise show a ten-minute session the instant somebody
 * signed in. The client keeps the difference and subtracts it — see
 * `WorkSessionProvider`.
 */
export interface WorkClock {
  /** ISO instant the current shift began, or null when none is running. */
  startedAt: string | null;
  /**
   * Seconds worked today in sessions that have **already ended**. Deliberately
   * excludes the running one, which the client adds live.
   */
  completedSecondsToday: number;
  /** The server's clock at the moment this was read, for skew correction. */
  serverNow: string;
  /** Local midnight, so the client clamps a shift that began yesterday. */
  todayStart: string;
}
