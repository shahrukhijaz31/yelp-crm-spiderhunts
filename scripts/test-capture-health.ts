/**
 * The screenshot-health thresholds, against fixtures.
 *
 *   npm run test:capture-health
 *
 * No Postgres, no dev server, no clock. Unlike the other `test:*` scripts in
 * here — which have to speak HTTP because the claims they check are about routes,
 * tokens and rows — every claim below is a decision made by one pure function in
 * `lib/captureHealthRules.ts`, so a fixture is the honest way to check it and the
 * only way to check the boundaries without waiting hours for time to pass.
 *
 * The live half (that the Monitor's report reaches the device row, and that the
 * dashboard shows it) is in `scripts/test-capture-health-live.ts`.
 */

import {
  evaluateCaptureHealth,
  describeCaptureHealth,
  isCaptureReportedReason,
  CAPTURE_REPORTED_REASONS,
  UNHEALTHY_AFTER_MISSED,
  WARNING_AFTER_MISSED,
  REASON_FRESH_INTERVALS,
  type CaptureHealthInput,
  type CaptureReportedReason,
} from "../lib/captureHealthRules";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const MINUTE = 60_000;
const NOW = new Date("2026-08-19T15:00:00.000Z");
const MAX_INTERVAL_MINUTES = 30;
const STALE_MS = 30 * MINUTE;

/** A live, healthy baseline that each case perturbs one field of. */
function scenario(over: Partial<CaptureHealthInput> = {}): CaptureHealthInput {
  return {
    now: NOW,
    sessionStartedAt: new Date(NOW.getTime() - 6 * 60 * MINUTE),
    lastMonitorSeenAt: new Date(NOW.getTime() - MINUTE),
    lastScreenshotAt: new Date(NOW.getTime() - 5 * MINUTE),
    reported: { reason: "ok", at: new Date(NOW.getTime() - MINUTE) },
    maxIntervalMinutes: MAX_INTERVAL_MINUTES,
    monitorStaleMs: STALE_MS,
    ...over,
  };
}

/** A gap of exactly `n` cadence intervals. */
function gapOf(intervals: number): Date {
  return new Date(NOW.getTime() - intervals * MAX_INTERVAL_MINUTES * MINUTE);
}

console.log("\nScreenshot health thresholds\n");

/* -------------------------------------------------------------------------- */
console.log("A healthy workstation");
{
  const v = evaluateCaptureHealth(scenario());
  check("recent screenshot reads ok", v.state === "ok", v.state);
  check("no missed intervals", v.missedIntervals === 0, String(v.missedIntervals));
  check("not flagged as contradicted", v.contradicted === false);
}

/* -------------------------------------------------------------------------- */
console.log("\nThe thresholds");
{
  const justUnderWarning = evaluateCaptureHealth(
    scenario({ lastScreenshotAt: gapOf(WARNING_AFTER_MISSED - 1) }),
  );
  check(
    `${WARNING_AFTER_MISSED - 1} missed interval stays ok (the random first delay)`,
    justUnderWarning.state === "ok",
    justUnderWarning.state,
  );

  const atWarning = evaluateCaptureHealth(
    scenario({ lastScreenshotAt: gapOf(WARNING_AFTER_MISSED) }),
  );
  check(`${WARNING_AFTER_MISSED} missed intervals warns`, atWarning.state === "warning", atWarning.state);

  const justUnderUnhealthy = evaluateCaptureHealth(
    scenario({ lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED - 1) }),
  );
  check(
    `${UNHEALTHY_AFTER_MISSED - 1} missed intervals is still only a warning`,
    justUnderUnhealthy.state === "warning",
    justUnderUnhealthy.state,
  );

  const atUnhealthy = evaluateCaptureHealth(
    scenario({ lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED) }),
  );
  check(
    `${UNHEALTHY_AFTER_MISSED} missed intervals is unhealthy`,
    atUnhealthy.state === "unhealthy",
    atUnhealthy.state,
  );
}

/* -------------------------------------------------------------------------- */
console.log("\nNever a single screenshot (capture blocked before the first cycle)");
{
  // The MON-01 shape: the deny ACE was applied before the shift's first capture,
  // so there is no screenshot to measure a gap from.
  const v = evaluateCaptureHealth(
    scenario({
      lastScreenshotAt: null,
      sessionStartedAt: gapOf(UNHEALTHY_AFTER_MISSED + 1),
      reported: { reason: "write-failed", at: new Date(NOW.getTime() - MINUTE) },
    }),
  );
  check("measured from the shift start instead", v.state === "unhealthy", v.state);
  check("carries the write-failed reason", v.reason === "write-failed", String(v.reason));
  check("write-failed is not benign", v.benign === false);
  check(
    "the description names the capture directory",
    /capture directory/i.test(describeCaptureHealth(v)),
    describeCaptureHealth(v),
  );
}

/* -------------------------------------------------------------------------- */
console.log("\nNo Monitor at all is not a screenshot problem");
{
  const never = evaluateCaptureHealth(
    scenario({ lastMonitorSeenAt: null, lastScreenshotAt: null, sessionStartedAt: gapOf(9) }),
  );
  check("a shift that never saw a Monitor", never.state === "not-monitored", never.state);

  const gone = evaluateCaptureHealth(
    scenario({
      lastMonitorSeenAt: new Date(NOW.getTime() - STALE_MS - MINUTE),
      lastScreenshotAt: gapOf(9),
    }),
  );
  check("a Monitor that went quiet past the grace window", gone.state === "not-monitored", gone.state);

  const justInside = evaluateCaptureHealth(
    scenario({
      lastMonitorSeenAt: new Date(NOW.getTime() - STALE_MS + MINUTE),
      lastScreenshotAt: gapOf(9),
    }),
  );
  check(
    "a Monitor still just inside the window is judged on the gap",
    justInside.state === "unhealthy",
    justInside.state,
  );
}

/* -------------------------------------------------------------------------- */
console.log("\nBenign explanations are surfaced, not treated as interference");
{
  for (const reason of ["locked", "suspended", "monitoring-inactive", "portal-offline"] as const) {
    const v = evaluateCaptureHealth(
      scenario({
        lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED),
        reported: { reason, at: new Date(NOW.getTime() - MINUTE) },
      }),
    );
    check(`${reason}: still reported`, v.state === "unhealthy", v.state);
    check(`${reason}: marked benign`, v.benign === true);
    check(`${reason}: not contradicted`, v.contradicted === false);
    check(
      `${reason}: named in the description`,
      describeCaptureHealth(v).includes(reason),
      describeCaptureHealth(v),
    );
  }
}

/* -------------------------------------------------------------------------- */
console.log("\nThe tampering signature: client says ok, nothing arrives");
{
  const v = evaluateCaptureHealth(
    scenario({
      lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED),
      reported: { reason: "ok", at: new Date(NOW.getTime() - MINUTE) },
    }),
  );
  check("flagged as contradicted", v.contradicted === true);
  check("state is unhealthy", v.state === "unhealthy", v.state);
  check(
    "the description says to investigate",
    /investigate/i.test(describeCaptureHealth(v)),
    describeCaptureHealth(v),
  );

  // Not raised while the gap is merely a warning — one unlucky cadence is not deceit.
  const warning = evaluateCaptureHealth(
    scenario({
      lastScreenshotAt: gapOf(WARNING_AFTER_MISSED),
      reported: { reason: "ok", at: new Date(NOW.getTime() - MINUTE) },
    }),
  );
  check("not raised at warning level", warning.contradicted === false);
}

/* -------------------------------------------------------------------------- */
console.log("\nA stale reason cannot leave a reassuring answer behind");
{
  const stale = evaluateCaptureHealth(
    scenario({
      lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED),
      reported: {
        reason: "ok",
        at: new Date(NOW.getTime() - (REASON_FRESH_INTERVALS + 1) * MAX_INTERVAL_MINUTES * MINUTE),
      },
    }),
  );
  check("an expired reason is dropped", stale.reason === null, String(stale.reason));
  check("so it cannot read as contradicted", stale.contradicted === false);
  check("the gap still stands alone", stale.state === "unhealthy", stale.state);
  check(
    "the description says no explanation was reported",
    /no explanation/i.test(describeCaptureHealth(stale)),
    describeCaptureHealth(stale),
  );

  const noneEver = evaluateCaptureHealth(
    scenario({ lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED), reported: null }),
  );
  check("a client that never reports still gets judged", noneEver.state === "unhealthy", noneEver.state);
  check("with no reason attached", noneEver.reason === null);
}

/* -------------------------------------------------------------------------- */
console.log("\nThe reason is a diagnostic and never the decision");
{
  // The property that matters most: whatever the client claims, the state comes
  // from the gap. A tampered Monitor cannot talk its way back to `ok`.
  const claims: CaptureReportedReason[] = [...CAPTURE_REPORTED_REASONS];
  const states = new Set(
    claims.map(
      (reason) =>
        evaluateCaptureHealth(
          scenario({
            lastScreenshotAt: gapOf(UNHEALTHY_AFTER_MISSED),
            reported: { reason, at: new Date(NOW.getTime() - MINUTE) },
          }),
        ).state,
    ),
  );
  check(
    "every possible claim still yields unhealthy on a long gap",
    states.size === 1 && states.has("unhealthy"),
    [...states].join(","),
  );

  // And the converse: a pessimistic claim cannot invent a problem that the
  // screenshots themselves contradict.
  const healthyDespiteClaim = evaluateCaptureHealth(
    scenario({ reported: { reason: "write-failed", at: new Date(NOW.getTime() - MINUTE) } }),
  );
  check(
    "a failure claim does not override arriving screenshots",
    healthyDespiteClaim.state === "ok",
    healthyDespiteClaim.state,
  );
}

/* -------------------------------------------------------------------------- */
console.log("\nInput validation");
{
  check("known reasons accepted", CAPTURE_REPORTED_REASONS.every(isCaptureReportedReason));
  for (const bad of ["OK", "", "write_failed", "../../etc", null, 7, {}, []]) {
    check(`rejects ${JSON.stringify(bad)}`, !isCaptureReportedReason(bad));
  }
}

/* -------------------------------------------------------------------------- */
console.log("\nDegenerate inputs do not throw or produce nonsense");
{
  const future = evaluateCaptureHealth(
    scenario({ lastScreenshotAt: new Date(NOW.getTime() + 10 * MINUTE) }),
  );
  check("a future screenshot clamps to a zero gap", future.gapMinutes === 0, String(future.gapMinutes));
  check("and reads ok", future.state === "ok", future.state);

  const zeroCadence = evaluateCaptureHealth(
    scenario({ maxIntervalMinutes: 0, lastScreenshotAt: gapOf(1) }),
  );
  check("a zero cadence does not divide by zero", Number.isFinite(zeroCadence.missedIntervals));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
