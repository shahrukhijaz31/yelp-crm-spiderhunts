/**
 * What counts as an app-usage segment: the limits, the normalisation, and the
 * validation that enforces both — plus the shapes the reports send to a screen.
 *
 * The same split `lib/activityRules.ts` keeps from `lib/activity.ts`: nothing
 * here touches the database, the filesystem or `next/headers`, so a route
 * handler, a server page and a client component can all import it. Everything
 * below is pure — input in, a value or a typed error out.
 *
 * ---------------------------------------------------------------------------
 * What this file will never contain
 * ---------------------------------------------------------------------------
 * A classification. There is no list of productive applications here, no
 * category map, no weight and no score. The feature reports how long an
 * application was in the foreground and stops there — `Chrome` is not
 * productive, `WhatsApp` is not a distraction, and neither this module nor
 * anything downstream of it feeds `lib/productivity.ts`. Adding such a list
 * would be a product decision dressed as a constant.
 */

import { resolveRange, type DateRange } from "./performanceRules";

/** An expected refusal, carrying the status the route should answer with. */
export class AppUsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The shortest segment worth a row.
 *
 * Below five seconds a foreground segment is somebody alt-tabbing past a
 * window on the way to another one. Storing those would multiply the row count
 * for time that rounds to nothing on every report, so the client is expected to
 * merge or drop them; the server refuses them rather than accepting rows it
 * would then have to filter out of every aggregate.
 */
export const MIN_SEGMENT_SECONDS = 5;

/**
 * The longest a single segment may claim to be.
 *
 * Four hours is longer than any real uninterrupted stretch in one window and
 * far shorter than a shift, so it refuses a client that lost track of a switch
 * and reported a whole day as one row without ever refusing a genuine morning
 * spent in a browser. A segment longer than this is a client bug, and accepting
 * it would put hours nobody observed onto somebody's report.
 */
export const MAX_SEGMENT_SECONDS = 4 * 60 * 60;

/**
 * How far a segment's *end* may sit from the server's clock.
 *
 * Fifteen minutes, matching `CLOCK_SKEW_TOLERANCE_MS` in `lib/activityRules.ts`
 * exactly, and refused rather than clamped for the same reason: a segment *is*
 * its timestamps, so a clamped one would invent foreground time nobody saw.
 *
 * Only the end is bounded against the clock. The start is bounded by the
 * segment length above and by the shift below, which is what lets a legitimate
 * three-hour stretch in one window be reported the moment it ends.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 15 * 60 * 1000;

/** The longest a process name may be after its directory has been stripped. */
export const MAX_PROCESS_NAME = 120;

/**
 * The longest an application label may be.
 *
 * Short on purpose. `Google Chrome`, `Microsoft Edge`, `WhatsApp`, `Visual
 * Studio Code` — the longest real label anybody has is a couple of dozen
 * characters, and a *window title* is almost always longer than this. The bound
 * is therefore doing two jobs: keeping the group-by key small, and making the
 * obvious misuse of the field fail loudly instead of quietly filling the
 * database with the names of documents people had open.
 */
export const MAX_APPLICATION_NAME = 80;

/** The idempotency key's shape. The same one activity intervals use. */
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

/**
 * What the Monitor sends.
 *
 * Note what is absent and cannot be added: there is no `userId`, no `agentId`
 * and no `workSessionId` in this shape. The route derives all three from the
 * authenticated device and the portal's own view of the shift, so a body
 * carrying them has nowhere to put them — which is stronger than ignoring them,
 * because there is no field to forget to ignore.
 */
export interface AppUsageSubmission {
  processName: string;
  applicationName: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  clientKey: string;
}

/** The bounds a submission is checked against, resolved by the caller. */
export interface AppUsageBounds {
  /** The server's clock at the moment of the request. */
  now: Date;
  /** When the resolved work session began. A segment cannot predate its shift. */
  sessionStartedAt: Date;
}

/** A parseable instant, or null. */
function instant(raw: unknown): Date | null {
  if (typeof raw !== "string" && !(raw instanceof Date)) return null;
  const parsed = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** CR, LF, NUL and friends — anything below 0x20, plus DEL. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * `C:\Program Files\Google\Chrome\chrome.exe` -> `chrome.exe`.
 *
 * The directory is dropped on the way in rather than at display time, so it is
 * never stored at all. A full path carries the account name and the shape of
 * somebody's disk — `C:\Users\umar\…` — and this feature has no use for either.
 * Both separators are handled because the client is Windows today and the
 * server should not care tomorrow.
 */
export function baseProcessName(raw: string): string {
  const trimmed = raw.trim();
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Turn an untrusted body into a submission, or refuse it.
 *
 * Refuses rather than clamps, for the reason `validateActivitySubmission` gives:
 * this is reading something that will be added to a person's reported time, and
 * a silently clamped segment is indistinguishable in the database from an
 * observed one.
 *
 * The order is cheapest-first and most-specific-message-first, so a client
 * debugging its integration gets the one refusal that names its actual mistake.
 */
export function validateAppUsageSubmission(
  body: unknown,
  bounds: AppUsageBounds,
): AppUsageSubmission {
  if (typeof body !== "object" || body === null) {
    throw new AppUsageError("invalid_body", "Request body must be a JSON object.", 400);
  }

  const payload = body as Record<string, unknown>;

  // --- the idempotency key ------------------------------------------------
  const clientKey = typeof payload.clientKey === "string" ? payload.clientKey.trim() : "";
  if (!CLIENT_KEY_PATTERN.test(clientKey)) {
    throw new AppUsageError(
      "invalid_client_key",
      "clientKey must be 8–120 characters of A–Z, a–z, 0–9, dot, underscore, colon or hyphen.",
      400,
    );
  }

  // --- the two names ------------------------------------------------------
  const processName = baseProcessName(
    typeof payload.processName === "string" ? payload.processName : "",
  );
  if (
    processName.length === 0 ||
    processName.length > MAX_PROCESS_NAME ||
    hasControlCharacter(processName)
  ) {
    throw new AppUsageError(
      "invalid_process_name",
      `processName must be 1–${MAX_PROCESS_NAME} printable characters (the executable, not a path).`,
      400,
    );
  }

  const applicationName =
    typeof payload.applicationName === "string" ? payload.applicationName.trim() : "";
  if (
    applicationName.length === 0 ||
    applicationName.length > MAX_APPLICATION_NAME ||
    hasControlCharacter(applicationName)
  ) {
    throw new AppUsageError(
      "invalid_application_name",
      `applicationName must be 1–${MAX_APPLICATION_NAME} printable characters.`,
      400,
    );
  }

  /*
   * A label, not an address. `applicationName` is the key every report groups
   * by, and a URL in it would mean this table had started recording where
   * somebody browsed — which is exactly what the schema note says it never
   * does. Refused rather than stripped: a client sending one has misunderstood
   * the field, and quietly accepting a truncated version would hide that.
   */
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(applicationName) || applicationName.includes("://")) {
    throw new AppUsageError(
      "invalid_application_name",
      "applicationName is an application label, not a URL. URLs are never stored.",
      422,
    );
  }

  // --- the window ---------------------------------------------------------
  const startedAt = instant(payload.startedAt);
  const endedAt = instant(payload.endedAt);
  if (!startedAt || !endedAt) {
    throw new AppUsageError(
      "invalid_timestamps",
      "startedAt and endedAt must both be ISO 8601 instants.",
      400,
    );
  }

  if (endedAt <= startedAt) {
    throw new AppUsageError("invalid_timestamps", "endedAt must be after startedAt.", 422);
  }

  const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  if (durationSeconds < MIN_SEGMENT_SECONDS || durationSeconds > MAX_SEGMENT_SECONDS) {
    throw new AppUsageError(
      "invalid_duration",
      `An app usage segment must be between ${MIN_SEGMENT_SECONDS} and ${MAX_SEGMENT_SECONDS} seconds long (got ${durationSeconds}).`,
      422,
    );
  }

  // --- against the server's clock ----------------------------------------
  // The future bound is tight on purpose: a client may legitimately report a
  // segment that ended a few minutes ago, but nothing legitimate reports one
  // that has not finished happening.
  if (endedAt.getTime() > bounds.now.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    throw new AppUsageError(
      "timestamp_in_future",
      "That segment ends in the future. Check the workstation's clock.",
      422,
    );
  }

  if (endedAt.getTime() < bounds.now.getTime() - CLOCK_SKEW_TOLERANCE_MS) {
    throw new AppUsageError(
      "timestamp_too_old",
      "That segment is too old to accept. App usage is reported as it happens.",
      422,
    );
  }

  // --- against the shift it claims to be inside ---------------------------
  // The work session is the authority on when work happened, so a segment that
  // starts before its shift did is refused rather than trimmed. Trimming would
  // be the server inventing a window, which is the one thing this module exists
  // to prevent.
  if (startedAt < bounds.sessionStartedAt) {
    throw new AppUsageError(
      "outside_work_session",
      "That segment starts before the current work session did.",
      422,
    );
  }

  return { processName, applicationName, startedAt, endedAt, durationSeconds, clientKey };
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The admin filters, from a query string.
 *
 * `agent` and `application` are *filters*, never permissions — the caller's
 * identity comes from the session row and is not in the URL. Both are read
 * leniently and clamped rather than refused, exactly as `resolveRange` is, so a
 * stale bookmark shows a report rather than a 400.
 */
export interface AppUsageFilters {
  /** One agent, or null for everybody. */
  userId: string | null;
  /** One application label, matched case-insensitively, or null for all. */
  application: string | null;
}

export const NO_APP_USAGE_FILTERS: AppUsageFilters = { userId: null, application: null };

export function resolveAppUsageFilters(params: URLSearchParams): AppUsageFilters {
  const agent = (params.get("agent") ?? "").trim();
  const application = (params.get("application") ?? "").trim();

  return {
    // "all" is what the picker sends for no filter, and an id is an opaque
    // cuid — an id that names nobody simply reports nothing, which is why it is
    // safe to pass through without a lookup.
    userId: agent === "" || agent === "all" ? null : agent.slice(0, 64),
    application:
      application === "" || application === "all"
        ? null
        : application.slice(0, MAX_APPLICATION_NAME),
  };
}

/**
 * The report's period. The same resolver the timesheet and productivity screens
 * use, so "this week" means the same days on every admin screen.
 *
 * Today / This week / This month in the brief are its `today`, `last7` and
 * `last30`; `custom` is the date pair.
 */
export function resolveAppUsageRange(params: URLSearchParams, today?: string): DateRange {
  return resolveRange(params.get("range"), params.get("from"), params.get("to"), today);
}

/* -------------------------------------------------------------------------- */
/* What crosses to the browser                                                */
/* -------------------------------------------------------------------------- */

/**
 * One application's line on the report.
 *
 * Two percentages, because there are two honest denominators and conflating
 * them is how a monitoring screen starts lying:
 *
 *   shareOfAppTime      this application ÷ all recorded app usage in the window.
 *                       These add to 100% across the rows, which is what the
 *                       "Chrome 55%, Edge 14%" reading of the report means.
 *   shareOfTrackedTime  this application ÷ the agent's tracked (signed-in)
 *                       time. These do **not** add to 100%, and the gap is real:
 *                       it is time on the clock that the Monitor reported no
 *                       foreground application for — the app was closed, the
 *                       machine was locked, or the agent was on a call.
 */
export interface AppUsageApplication {
  applicationName: string;
  seconds: number;
  /** How many foreground segments made it up. */
  segments: number;
  shareOfAppTime: number;
  shareOfTrackedTime: number;
  /**
   * True for the single synthetic row that carries everything outside the top
   * of the list. Never a real application, and never linkable.
   */
  other?: boolean;
}

/** The figures above the application table. Every one is counted, never estimated. */
export interface AppUsageSummary {
  /** Seconds of app usage recorded in the window, after filters. */
  recordedSeconds: number;
  /** Seconds the agents in scope were signed in and working, from work_sessions. */
  trackedSeconds: number;
  /**
   * All app usage in the window ÷ tracked time, as a percentage, or null when
   * there is no tracked time to divide by. The honesty figure: it says how much
   * of the period the Monitor reported an application for at all.
   *
   * Measured over the **whole** window even when an application filter is
   * applied — the numerator is every application, not the filtered one. A
   * coverage figure that moved when the reader narrowed the table would be
   * saying "the Monitor covered 12% of the day" about a filter rather than
   * about the day, and the per-application share already answers that question.
   */
  coveragePercentage: number | null;
  /** Distinct application labels seen in the window, before the "Other" fold. */
  applications: number;
  /** The instant these were read, so a client clock can label them honestly. */
  asOf: string;
}

/** One employee's app usage, as the employee view shows it. */
export interface EmployeeAppUsage {
  user: { id: string; name: string; username: string; role: "ADMIN" | "AGENT" };
  trackedSeconds: number;
  /** Duration-weighted mean over the window, or null when nothing was observed. */
  activityPercentage: number | null;
  recordedSeconds: number;
  applications: AppUsageApplication[];
}

/** The whole admin report payload. */
export interface AppUsageReport {
  range: { from: string; to: string; label: string; key: string };
  filters: { agent: string | null; application: string | null };
  summary: AppUsageSummary;
  applications: AppUsageApplication[];
  /** Present only when one agent is selected. */
  employee: EmployeeAppUsage | null;
}

/** One entry on the daily timeline. Application only — never a window title. */
export interface AppUsageTimelineEntry {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  applicationName: string;
  processName: string;
}

export interface AppUsageTimeline {
  user: { id: string; name: string };
  range: { from: string; to: string; label: string };
  entries: AppUsageTimelineEntry[];
  /** True when the window held more entries than the cap returned. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** `55` -> `55%`, `null` -> `—`. The one place the em dash is decided. */
export function formatShare(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/**
 * `1234` seconds out of `10000` -> `12`.
 *
 * Rounded to a whole percent, and floored at zero. Returns null for a zero
 * denominator rather than 0, so "nothing was recorded" and "this application
 * was 0% of what was recorded" stay different facts all the way to the screen —
 * the same discipline `weightedActivity` applies to the activity percentage.
 */
export function share(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.max(0, Math.round((part / whole) * 100));
}
