/**
 * Deciding whether a monitored workstation is actually taking screenshots.
 *
 * ---------------------------------------------------------------------------
 * The hole this closes
 * ---------------------------------------------------------------------------
 * Screenshot capture could be switched off, permanently and invisibly, by the
 * person being monitored. The capture directory lives inside the agent's own
 * roaming profile, so as its owner they may add a deny ACE against themselves —
 * `writeCapture` then fails with `EPERM`, the Monitor's capture cycle returns
 * `write-failed` *before* it reaches the upload path, and nothing is ever sent
 * here. Activity intervals, app-usage segments and the device heartbeat all
 * carry on, so the shift looked perfectly healthy while no screenshot had
 * arrived for hours. The ACE is removed again in one command.
 *
 * ---------------------------------------------------------------------------
 * Two signals, and only one of them can be trusted
 * ---------------------------------------------------------------------------
 *   the gap       How long since a screenshot actually arrived, measured here,
 *                 against the cadence *this server* set. **This is the control.**
 *                 A client cannot forge it, because it is the absence of data —
 *                 there is nothing for a tampered Monitor to send that makes a
 *                 missing row appear.
 *
 *   the reason    What the Monitor says went wrong. **This is a diagnostic and
 *                 nothing more.** A modified client will happily report `ok`
 *                 forever, so no decision may rest on it. It exists because
 *                 without it the gap alone is unactionable: a workstation locked
 *                 over a long lunch legitimately produces no screenshots and is
 *                 indistinguishable from a blocked directory, and an alert that
 *                 fires on both is an alert people learn to ignore.
 *
 * The interesting case is the two disagreeing. A client insisting `ok` while no
 * screenshot has arrived for four cadence intervals is the signature of tampering
 * or of a silently broken upload, and {@link CaptureHealthVerdict.contradicted}
 * says so out loud rather than leaving an administrator to notice.
 *
 * ---------------------------------------------------------------------------
 * Why this file is pure
 * ---------------------------------------------------------------------------
 * Same reason `activityRules.ts` and `appUsageRules.ts` are: the thresholds are
 * the part worth testing, and they are testable here with fixtures, no Postgres
 * and no clock. `lib/captureHealth.ts` does the reading; this decides.
 */

/** How the Monitor last described its own capture subsystem. */
export type CaptureReportedReason =
  /** A capture was taken and uploaded. */
  | "ok"
  /** Refused locally, and legitimately so — nothing was on screen to capture. */
  | "locked"
  | "suspended"
  /** The portal itself said this agent is not on the clock. */
  | "monitoring-inactive"
  | "not-signed-in"
  /** The server could not be reached, so nothing was attempted. */
  | "portal-offline"
  /** No usable display. */
  | "display-unavailable"
  /** `desktopCapturer` produced nothing. */
  | "capture-failed"
  /** The image could not be written to disk. The MON-01 signature. */
  | "write-failed"
  /** Captured and written, but the upload was refused. */
  | "upload-failed";

/**
 * Reasons that explain an absent screenshot without implying interference.
 *
 * A locked or sleeping workstation genuinely has nothing worth photographing,
 * and an agent who is not on the clock should not be photographed at all — the
 * Monitor refusing in those states is it working correctly. They are still
 * *surfaced*, because "clocked on and locked for two hours" is a fact an
 * administrator may want, but they are not presented as tampering.
 */
const BENIGN_REASONS: ReadonlySet<CaptureReportedReason> = new Set([
  "ok",
  "locked",
  "suspended",
  "monitoring-inactive",
  "not-signed-in",
  "portal-offline",
]);

/** Every reason the Monitor is allowed to report. Used to validate the body. */
export const CAPTURE_REPORTED_REASONS: readonly CaptureReportedReason[] = [
  "ok",
  "locked",
  "suspended",
  "monitoring-inactive",
  "not-signed-in",
  "portal-offline",
  "display-unavailable",
  "capture-failed",
  "write-failed",
  "upload-failed",
];

export function isCaptureReportedReason(value: unknown): value is CaptureReportedReason {
  return (
    typeof value === "string" &&
    (CAPTURE_REPORTED_REASONS as readonly string[]).includes(value)
  );
}

export type CaptureHealthState =
  /** Screenshots are arriving about as often as the cadence implies. */
  | "ok"
  /** One or two intervals have passed with nothing. Often transient. */
  | "warning"
  /** Long enough that something is wrong. */
  | "unhealthy"
  /**
   * No Monitor is watching this shift, so absent screenshots are already
   * explained and this is not a screenshot problem. Kept distinct from
   * `unhealthy` so the dashboard does not report the same fact twice.
   */
  | "not-monitored";

export interface CaptureHealthInput {
  now: Date;
  /** The open shift's start — the baseline when no screenshot has ever arrived. */
  sessionStartedAt: Date;
  /** Last authenticated Monitor request against this shift, or null. */
  lastMonitorSeenAt: Date | null;
  /** Newest screenshot **the server holds** for this shift, or null. */
  lastScreenshotAt: Date | null;
  /** What the Monitor last claimed, and when the server recorded it. */
  reported: { reason: CaptureReportedReason; at: Date } | null;
  /**
   * The upper bound of the capture window this server configured, in minutes.
   * The *maximum* rather than the minimum deliberately: the schedule is random
   * inside [min, max], so only the maximum lets this say "by now, one should
   * have arrived" without ever crying wolf at a legitimately late capture.
   */
  maxIntervalMinutes: number;
  /** The liveness grace window — `STALE_MS` in `lib/workSessions.ts`. */
  monitorStaleMs: number;
}

export interface CaptureHealthVerdict {
  state: CaptureHealthState;
  /** Whole minutes since the last screenshot arrived, or since the shift began. */
  gapMinutes: number;
  /** How many captures the cadence implies should have arrived in that gap. */
  missedIntervals: number;
  /** The Monitor's own explanation, when it is recent enough to be about now. */
  reason: CaptureReportedReason | null;
  /** True when {@link reason} explains the gap without implying interference. */
  benign: boolean;
  /**
   * The Monitor reports healthy capture, and no screenshot has arrived anyway.
   *
   * The one combination that cannot be innocent: either the client is lying, or
   * uploads are failing in a way it cannot see. Both need a human.
   */
  contradicted: boolean;
}

/**
 * Missed intervals before the state moves off `ok`.
 *
 * Two, not one. The first capture of a shift is a random delay of up to
 * `maxIntervalMinutes`, and a cycle that skipped for a legitimate reason waits
 * a short retry — so a single missing interval is ordinary. Two consecutive
 * ones are not.
 */
export const WARNING_AFTER_MISSED = 2;

/** Missed intervals before the state becomes `unhealthy`. */
export const UNHEALTHY_AFTER_MISSED = 4;

/**
 * How long a reported reason stays relevant, as a multiple of the cadence.
 *
 * A reason older than this is describing a cycle that is no longer the current
 * one, so it is dropped rather than shown as though it were live. That also
 * means a Monitor that stops reporting cannot leave a stale, reassuring `ok`
 * behind it — the reason expires and the gap speaks alone.
 */
export const REASON_FRESH_INTERVALS = 3;

export function evaluateCaptureHealth(input: CaptureHealthInput): CaptureHealthVerdict {
  const {
    now,
    sessionStartedAt,
    lastMonitorSeenAt,
    lastScreenshotAt,
    reported,
    maxIntervalMinutes,
    monitorStaleMs,
  } = input;

  const cadenceMs = Math.max(1, maxIntervalMinutes) * 60_000;

  /*
   * The gap is measured from the last screenshot, or from the start of the shift
   * when none has ever arrived — which is the case that matters most, because a
   * workstation whose capture was blocked before the first cycle has no
   * screenshot to measure from at all.
   */
  const since = lastScreenshotAt ?? sessionStartedAt;
  const gapMs = Math.max(0, now.getTime() - since.getTime());
  const gapMinutes = Math.floor(gapMs / 60_000);
  const missedIntervals = Math.floor(gapMs / cadenceMs);

  // Only a reason recent enough to describe the present is reported as current.
  const reasonIsFresh =
    reported !== null &&
    now.getTime() - reported.at.getTime() <= cadenceMs * REASON_FRESH_INTERVALS;
  const reason = reasonIsFresh ? reported!.reason : null;
  const benign = reason !== null && BENIGN_REASONS.has(reason);

  /*
   * No Monitor, no screenshot problem.
   *
   * Checked before the gap so that "this agent is working with no Monitor
   * running" is reported as the one fact it is, rather than as both a liveness
   * problem and a capture problem. That state is already visible on the
   * dashboard through `online` and `lastActivityAt`.
   */
  const monitorAlive =
    lastMonitorSeenAt !== null && now.getTime() - lastMonitorSeenAt.getTime() <= monitorStaleMs;

  if (!monitorAlive) {
    return {
      state: "not-monitored",
      gapMinutes,
      missedIntervals,
      reason,
      benign,
      contradicted: false,
    };
  }

  const state: CaptureHealthState =
    missedIntervals >= UNHEALTHY_AFTER_MISSED
      ? "unhealthy"
      : missedIntervals >= WARNING_AFTER_MISSED
        ? "warning"
        : "ok";

  /*
   * A client claiming `ok` while the server has nothing.
   *
   * Only raised once the gap is genuinely long, so an upload still in flight or
   * one cadence of bad luck does not read as deceit.
   */
  const contradicted =
    state === "unhealthy" && reason === "ok";

  return { state, gapMinutes, missedIntervals, reason, benign, contradicted };
}

/**
 * One line an administrator can act on.
 *
 * Deliberately here rather than in the component: what a state *means* is a rule,
 * and rules belong with the other rules where they can be tested.
 */
export function describeCaptureHealth(verdict: CaptureHealthVerdict): string {
  if (verdict.state === "not-monitored") {
    return "No Monitor is reporting for this shift, so no screenshots are expected.";
  }

  if (verdict.state === "ok") {
    return verdict.reason && verdict.reason !== "ok"
      ? `Screenshots are up to date. Last cycle reported: ${verdict.reason}.`
      : "Screenshots are arriving as scheduled.";
  }

  const missed = `${verdict.missedIntervals} expected capture${verdict.missedIntervals === 1 ? "" : "s"} missing (${verdict.gapMinutes} min)`;

  if (verdict.contradicted) {
    return `${missed}. The workstation reports capture is healthy, which does not match — investigate for interference or a broken upload.`;
  }

  if (verdict.reason === "write-failed") {
    return `${missed}. The workstation cannot write captures to disk — check the capture directory's permissions.`;
  }

  if (verdict.benign) {
    return `${missed}, explained by the workstation as: ${verdict.reason}.`;
  }

  if (verdict.reason) {
    return `${missed}. The workstation reports: ${verdict.reason}.`;
  }

  return `${missed}, with no explanation reported by the workstation.`;
}
