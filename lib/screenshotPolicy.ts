/**
 * The screenshot cadence, the upload brake and the retention window — the three
 * numbers the *server* owns.
 *
 * ---------------------------------------------------------------------------
 * Why these live here and not on the workstation
 * ---------------------------------------------------------------------------
 * An agent must not be able to decide how often their own screen is
 * photographed, or how long the images are kept. If the desktop client held
 * those numbers, changing them would be editing a file on the machine being
 * monitored. So the portal holds them, ships the capture interval to the client
 * in the answer it already sends (`GET /api/monitor/session`), and enforces the
 * rest itself — the upload rate limit is applied on the way in, and retention
 * runs entirely server-side.
 *
 * The client's own defaults are a *fallback for an unreachable server*, not a
 * setting: it uses them only until the first successful poll, and the server's
 * answer replaces them.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a secret
 * ---------------------------------------------------------------------------
 * These four variables are timings. They are read at call time rather than at
 * module scope, for the reason `lib/ingestAuth.ts` gives: a module-level const
 * is captured during `next build`, where none of them is set.
 *
 * ---------------------------------------------------------------------------
 * Invalid configuration never breaks monitoring
 * ---------------------------------------------------------------------------
 * Every reader below falls back to its default and warns once. A typo in
 * `/etc/leadportal/env` should cost a log line, not an agent's whole day of
 * screenshots — and certainly not a retention sweep running against a window it
 * misparsed as zero.
 */

const DEFAULT_MIN_INTERVAL_MINUTES = 10;
const DEFAULT_MAX_INTERVAL_MINUTES = 30;

/** One accepted upload per device per this many minutes. See `screenshotRateLimit.ts`. */
const DEFAULT_UPLOAD_WINDOW_MINUTES = 5;

const DEFAULT_RETENTION_DAYS = 30;

/** Ten years. Past this a "retention policy" is a typo, not a decision. */
const MAX_RETENTION_DAYS = 3650;

/**
 * Test overrides are refused outside development, and refused below this even
 * inside it: a one-second capture loop is a way to fill a disk, not a test.
 */
const MIN_TEST_INTERVAL_SECONDS = 5;

function isDevelopment(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Warn once per key, so a bad value does not print on every request. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[screenshot-policy] ${message}`);
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

export interface CapturePolicy {
  /** Never below 60 in production. The client draws a uniform delay in [min, max]. */
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  /** `default`, `configured`, or `test` — for logging, never for behaviour. */
  source: "default" | "configured" | "test";
}

/**
 * How often a workstation should photograph its screen.
 *
 * `SCREENSHOT_MIN_INTERVAL_MINUTES` / `SCREENSHOT_MAX_INTERVAL_MINUTES`,
 * defaulting to 10 and 30. The pair is validated together — `min >= 1` and
 * `max > min` — because setting one of the two is the common case and a
 * configured minimum of 40 against the default maximum of 30 is exactly the
 * kind of half-change that should fall back rather than produce an empty range.
 *
 * `SCREENSHOT_MIN_INTERVAL_SECONDS` / `SCREENSHOT_MAX_INTERVAL_SECONDS` exist
 * so the scheduler can be tested in a minute instead of an hour. **They are
 * ignored unless `NODE_ENV` is something other than `production`**, so no
 * combination of environment variables on a real deployment can produce a
 * ten-second capture loop.
 */
export function capturePolicy(): CapturePolicy {
  if (isDevelopment()) {
    const testMin = positive("SCREENSHOT_MIN_INTERVAL_SECONDS");
    const testMax = positive("SCREENSHOT_MAX_INTERVAL_SECONDS");

    if (testMin !== null || testMax !== null) {
      const min = testMin ?? MIN_TEST_INTERVAL_SECONDS;
      const max = testMax ?? min * 2;

      if (min >= MIN_TEST_INTERVAL_SECONDS && max > min) {
        return {
          minIntervalSeconds: Math.round(min),
          maxIntervalSeconds: Math.round(max),
          source: "test",
        };
      }

      warnOnce(
        "test-interval",
        `SCREENSHOT_M{IN,AX}_INTERVAL_SECONDS must satisfy min >= ${MIN_TEST_INTERVAL_SECONDS} and max > min; ignoring them.`,
      );
    }
  }

  const configuredMin = positive("SCREENSHOT_MIN_INTERVAL_MINUTES");
  const configuredMax = positive("SCREENSHOT_MAX_INTERVAL_MINUTES");

  if (configuredMin === null && configuredMax === null) {
    return {
      minIntervalSeconds: DEFAULT_MIN_INTERVAL_MINUTES * 60,
      maxIntervalSeconds: DEFAULT_MAX_INTERVAL_MINUTES * 60,
      source: "default",
    };
  }

  const min = configuredMin ?? DEFAULT_MIN_INTERVAL_MINUTES;
  const max = configuredMax ?? DEFAULT_MAX_INTERVAL_MINUTES;

  if (min < 1 || max <= min) {
    warnOnce(
      "interval",
      `SCREENSHOT_MIN/MAX_INTERVAL_MINUTES must satisfy min >= 1 and max > min (got ${min} and ${max}); using ${DEFAULT_MIN_INTERVAL_MINUTES}–${DEFAULT_MAX_INTERVAL_MINUTES}.`,
    );
    return {
      minIntervalSeconds: DEFAULT_MIN_INTERVAL_MINUTES * 60,
      maxIntervalSeconds: DEFAULT_MAX_INTERVAL_MINUTES * 60,
      source: "default",
    };
  }

  return {
    minIntervalSeconds: Math.round(min * 60),
    maxIntervalSeconds: Math.round(max * 60),
    source: "configured",
  };
}

/**
 * The upload brake: one accepted screenshot per monitor device per this many
 * seconds.
 *
 * Deliberately a *separate* number from the capture interval rather than
 * derived from it. This one does not trust the client at all — it exists
 * precisely for the case where the client is not the client we shipped — so it
 * must not move when the cadence the client is told about moves.
 *
 * `SCREENSHOT_UPLOAD_MIN_INTERVAL_SECONDS` is the development-only companion to
 * the test capture interval: without it, testing at a ten-second cadence would
 * meet a 429 on every capture but the first and prove nothing.
 */
export function uploadWindowSeconds(): number {
  if (isDevelopment()) {
    const testWindow = positive("SCREENSHOT_UPLOAD_MIN_INTERVAL_SECONDS");
    if (testWindow !== null && testWindow >= 1) return Math.round(testWindow);
  }

  const minutes = positive("SCREENSHOT_UPLOAD_MIN_INTERVAL_MINUTES");
  if (minutes === null) return DEFAULT_UPLOAD_WINDOW_MINUTES * 60;

  if (minutes < 0.5 || minutes > 24 * 60) {
    warnOnce(
      "upload-window",
      `SCREENSHOT_UPLOAD_MIN_INTERVAL_MINUTES must be between 0.5 and 1440 (got ${minutes}); using ${DEFAULT_UPLOAD_WINDOW_MINUTES}.`,
    );
    return DEFAULT_UPLOAD_WINDOW_MINUTES * 60;
  }

  return Math.round(minutes * 60);
}

/**
 * How long a screenshot is kept before the retention sweep removes it, in days.
 *
 * A whole number: "keep 30.5 days" is not a policy anybody means, and rounding
 * it silently would be a worse answer than refusing it. Bounded above because a
 * mistyped `SCREENSHOT_RETENTION_DAYS=30000` is indistinguishable from "never
 * delete", which is the one thing this setting exists to prevent.
 */
export function retentionDays(): number {
  const value = positive("SCREENSHOT_RETENTION_DAYS");
  if (value === null) return DEFAULT_RETENTION_DAYS;

  if (!Number.isInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
    warnOnce(
      "retention",
      `SCREENSHOT_RETENTION_DAYS must be a whole number between 1 and ${MAX_RETENTION_DAYS} (got ${value}); using ${DEFAULT_RETENTION_DAYS}.`,
    );
    return DEFAULT_RETENTION_DAYS;
  }

  return value;
}
