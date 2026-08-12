/**
 * The activity cadence, the idle threshold and the calibration rate — the three
 * numbers the *server* owns about activity tracking.
 *
 * ---------------------------------------------------------------------------
 * Why this is a sibling of `screenshotPolicy.ts` and not something new
 * ---------------------------------------------------------------------------
 * This application already has a configuration mechanism for exactly this kind
 * of setting: environment variables, read at call time, validated with a
 * documented fallback and a warn-once. `lib/screenshotPolicy.ts` is it, and the
 * requirement it satisfies is the same one here — an agent must not be able to
 * change how their own activity is measured. A settings table would put the
 * numbers somewhere an application bug could write to; an environment variable
 * on a root-owned `/etc/leadportal/env` cannot be reached from any request at
 * all, whatever the caller's role. There is no UI to change these because there
 * must not be one.
 *
 * They are shipped to the desktop client on the answer it already polls
 * (`GET /api/monitor/session`), beside the screenshot cadence, for the reason
 * given there: a cadence the client holds is a cadence the monitored machine
 * decides.
 *
 * ---------------------------------------------------------------------------
 * Read at call time
 * ---------------------------------------------------------------------------
 * Not at module scope, for the reason `lib/ingestAuth.ts` and
 * `lib/screenshotPolicy.ts` both give: a module-level const is captured during
 * `next build`, where none of these is set.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a secret
 * ---------------------------------------------------------------------------
 * These are timings and a divisor. The agent is entitled to know that activity
 * is being counted; what they are not given is the ability to change it.
 */

/** How long one activity interval covers. The Monitor submits one per window. */
const DEFAULT_INTERVAL_SECONDS = 60;

/**
 * How long without any input before the agent is shown as inactive.
 *
 * Note what this is *not*: it does not end a work session, shorten one, or stop
 * the shift clock. `work_sessions` remains the authority on when somebody was
 * working (see the module note in `lib/workSessions.ts`), and this threshold
 * only decides how the dashboard labels them right now — "working" against
 * "idle" — and which intervals count as inactive in a report. An idle agent is
 * still on the clock, because they are still at work.
 */
const DEFAULT_IDLE_THRESHOLD_SECONDS = 5 * 60;

/**
 * The denominator of the activity percentage: how many keyboard-plus-mouse
 * events a minute counts as fully active.
 *
 * Deliberately modest. This is not a typing-speed target and it must not become
 * one — see the note on {@link expectedEventsPerMinute}.
 */
const DEFAULT_EXPECTED_EVENTS_PER_MINUTE = 120;

/** Bounds, past which a value is a typo rather than a decision. */
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 15 * 60;
const MIN_IDLE_THRESHOLD_SECONDS = 60;
const MAX_IDLE_THRESHOLD_SECONDS = 4 * 60 * 60;
const MIN_EXPECTED_EVENTS = 10;
const MAX_EXPECTED_EVENTS = 10_000;

/** Warn once per key, so a bad value does not print on every request. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[activity-policy] ${message}`);
}

/** A finite, strictly positive number, or null for "not configured". */
function positive(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    warnOnce(name, `${name} is not a positive number; ignoring it.`);
    return null;
  }

  return value;
}

/** Read a bounded whole number, falling back with one warning. */
function bounded(name: string, fallback: number, min: number, max: number): number {
  const value = positive(name);
  if (value === null) return fallback;

  if (!Number.isInteger(value) || value < min || value > max) {
    warnOnce(
      name,
      `${name} must be a whole number between ${min} and ${max} (got ${value}); using ${fallback}.`,
    );
    return fallback;
  }

  return value;
}

/**
 * How long an activity interval covers, in seconds.
 *
 * `ACTIVITY_INTERVAL_SECONDS`, default 60. This is the cadence the Monitor is
 * told to report on, and it is also what bounds an acceptable submission: the
 * API refuses an interval longer than twice this (`lib/activityRules.ts`), so
 * raising it here is what makes longer intervals acceptable. The two cannot
 * drift apart, because they are the same function call.
 */
export function activityIntervalSeconds(): number {
  return bounded(
    "ACTIVITY_INTERVAL_SECONDS",
    DEFAULT_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
}

/**
 * How long without input before an agent reads as inactive, in seconds.
 *
 * `ACTIVITY_IDLE_THRESHOLD_SECONDS`, default 300 (five minutes).
 *
 * Read by the dashboard to label a working agent idle, and by the reports to
 * split tracked time into active and inactive. Never read by anything that
 * opens, extends or closes a work session.
 */
export function inactivityThresholdSeconds(): number {
  return bounded(
    "ACTIVITY_IDLE_THRESHOLD_SECONDS",
    DEFAULT_IDLE_THRESHOLD_SECONDS,
    MIN_IDLE_THRESHOLD_SECONDS,
    MAX_IDLE_THRESHOLD_SECONDS,
  );
}

/**
 * Events per minute that count as 100% activity.
 *
 * `ACTIVITY_EXPECTED_EVENTS_PER_MINUTE`, default 120 — two events a second,
 * which a person typing or moving a mouse continuously passes easily and a
 * person reading a lead's notes does not.
 *
 * **This number is a calibration, not a target.** It exists so the percentage
 * has a stated denominator instead of being whatever the desktop client felt
 * like sending, and it is documented in `.env.example` and in the README for the
 * same reason. It is emphatically not a measure of productivity: a good call is
 * a quiet minute on this scale, and any reading of the percentage that forgets
 * that is a misreading. See {@link activityPercentage} in `lib/activityRules.ts`.
 */
export function expectedEventsPerMinute(): number {
  return bounded(
    "ACTIVITY_EXPECTED_EVENTS_PER_MINUTE",
    DEFAULT_EXPECTED_EVENTS_PER_MINUTE,
    MIN_EXPECTED_EVENTS,
    MAX_EXPECTED_EVENTS,
  );
}

/** Everything the server owns about activity, for the one endpoint that ships it. */
export interface ActivityPolicy {
  intervalSeconds: number;
  idleThresholdSeconds: number;
  expectedEventsPerMinute: number;
}

export function activityPolicy(): ActivityPolicy {
  return {
    intervalSeconds: activityIntervalSeconds(),
    idleThresholdSeconds: inactivityThresholdSeconds(),
    expectedEventsPerMinute: expectedEventsPerMinute(),
  };
}
