import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * End-to-end check of activity tracking: the Monitor's submission API, the
 * duplicate protection, the permission boundaries and the manual-correction
 * audit trail — against a running server and a real database.
 *
 *   npm run dev            (in one terminal)
 *   npm run test:activity  (in another)
 *
 * Written for the reason `test-screenshots.ts` and `test-screenshot-viewer.ts`
 * were: this repository has no test framework, and none of the claims worth
 * checking here are unit-testable in any useful sense. "An agent cannot submit
 * activity for a colleague" is a claim about an HTTP route, a bearer token, a
 * database lookup and the *absence* of a field — a mocked version would pass
 * whether or not the real thing works. So this speaks HTTP to the real routes
 * and then looks in Postgres to see what actually happened.
 *
 * It creates two throwaway agents (`acttest-*`), an administrator, their work
 * sessions and monitor devices, and deletes all of it on the way out, including
 * after a failure. It never touches an existing user, device, session or
 * interval.
 *
 * **Device rows and portal sessions are inserted directly rather than signed in
 * for.** A real sign-in needs a six-digit code delivered by email, which a test
 * cannot read. Both token constructions are copied from `lib/monitorAuth.ts` and
 * `lib/session.ts` (32 random bytes, SHA-256 into the row), so what the routes
 * authenticate is exactly what they authenticate in production.
 *
 * The Electron client is not covered and is not modified by this stage. What is
 * covered is everything the server owns.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "activity-test-Pa55phrase";

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  log: ["error"],
});

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A monitor device for a user, as `issueDeviceTokens` would have written it. */
async function connectDevice(userId: string): Promise<{ id: string; accessToken: string }> {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const now = Date.now();

  const device = await prisma.monitorDevice.create({
    data: {
      userId,
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: new Date(now + 15 * 60 * 1000),
      refreshTokenHash: hashToken(refreshToken),
      refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      deviceName: "activity-test",
      platform: "win32",
      appVersion: "test",
    },
    select: { id: true },
  });

  return { id: device.id, accessToken };
}

/** Mint a portal session for a user and return the cookie header value. */
async function signIn(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + 12 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      userAgent: "activity-test",
      ipAddress: "127.0.0.1",
    },
  });

  return `${SESSION_COOKIE}=${token}`;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function postActivity(
  accessToken: string | null,
  payload: Record<string, unknown>,
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}/api/monitor/activity`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  return { status: response.status, body: await readJson(response) };
}

async function get(url: string, cookie?: string): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${url}`, {
    headers: cookie ? { cookie } : {},
    // The portal redirects unauthenticated *pages*; the API answers 401. Either
    // way a redirect must not be followed, or the status under test is lost.
    redirect: "manual",
  });

  return { status: response.status, body: await readJson(response) };
}

async function postJson(
  url: string,
  cookie: string | undefined,
  payload: unknown,
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
    redirect: "manual",
  });

  return { status: response.status, body: await readJson(response) };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A well-formed interval ending now, with the counts the caller wants. */
function interval(
  overrides: Record<string, unknown> = {},
  seconds = 60,
): Record<string, unknown> {
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - seconds * 1000);

  return {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    keyboardActivityCount: 40,
    mouseActivityCount: 20,
    clientKey: `test-${randomBytes(8).toString("hex")}`,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const created: string[] = [];

async function main(): Promise<void> {
  console.log(`Activity tracking checks against ${BASE_URL}\n`);

  const stamp = Date.now();
  const passwordHash = await hashPassword(PASSWORD);

  const alice = await prisma.user.create({
    data: {
      username: `acttest-alice-${stamp}`,
      email: `acttest-alice-${stamp}@example.test`,
      name: "Activity Test Alice",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  const bob = await prisma.user.create({
    data: {
      username: `acttest-bob-${stamp}`,
      email: `acttest-bob-${stamp}@example.test`,
      name: "Activity Test Bob",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  const admin = await prisma.user.create({
    data: {
      username: `acttest-admin-${stamp}`,
      email: `acttest-admin-${stamp}@example.test`,
      name: "Activity Test Admin",
      passwordHash,
      role: "ADMIN",
    },
    select: { id: true },
  });
  created.push(alice.id, bob.id, admin.id);

  // An open shift for Alice, beating now so `getActiveWorkSession` sees it.
  const aliceShift = await prisma.workSession.create({
    data: { userId: alice.id, startedAt: new Date(Date.now() - 60 * 60 * 1000), lastSeenAt: new Date() },
    select: { id: true },
  });

  // A finished shift for Alice, for the correction tests.
  const finishedStart = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const finishedEnd = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const aliceFinished = await prisma.workSession.create({
    data: {
      userId: alice.id,
      startedAt: finishedStart,
      lastSeenAt: finishedEnd,
      endedAt: finishedEnd,
      durationSeconds: 2 * 60 * 60,
      endedReason: "logout",
    },
    select: { id: true },
  });

  // Bob has a device but deliberately no open shift.
  const aliceDevice = await connectDevice(alice.id);
  const bobDevice = await connectDevice(bob.id);

  const aliceCookie = await signIn(alice.id);
  const bobCookie = await signIn(bob.id);
  const adminCookie = await signIn(admin.id);

  const workSessionsBefore = await prisma.workSession.count();

  /* --- submission ------------------------------------------------------- */
  section("Activity submission");

  const first = interval();
  const accepted = await postActivity(aliceDevice.accessToken, first);
  check("an agent's activity is accepted", accepted.status === 201, `status ${accepted.status}`);

  const stored = await prisma.activityInterval.findFirst({
    where: { userId: alice.id },
    orderBy: { createdAt: "desc" },
  });
  check("a row was written", stored !== null);
  check(
    "the correct agent is associated automatically",
    stored?.userId === alice.id,
    `got ${stored?.userId}`,
  );
  check(
    "the server resolved the work session itself",
    stored?.workSessionId === aliceShift.id,
    `got ${stored?.workSessionId}`,
  );

  /* --- the client cannot name anybody ------------------------------------ */
  section("Authorization is never taken from the body");

  const impersonation = await postActivity(
    aliceDevice.accessToken,
    interval({
      // Every one of these is ignored: they are not read from the request at
      // all, which is stronger than being validated away.
      userId: bob.id,
      agentId: bob.id,
      workSessionId: aliceFinished.id,
      activityPercentage: 100,
    }),
  );
  check("a submission naming another agent is still accepted", impersonation.status === 201);

  const impersonated = await prisma.activityInterval.findFirst({
    where: { id: (impersonation.body.interval as { id?: string })?.id },
  });
  check(
    "…but is attributed to the authenticated agent, not the named one",
    impersonated?.userId === alice.id,
    `got ${impersonated?.userId}`,
  );
  check(
    "…and to the server-resolved shift, not the named one",
    impersonated?.workSessionId === aliceShift.id,
    `got ${impersonated?.workSessionId}`,
  );
  check(
    "no activity row was created for the other agent",
    (await prisma.activityInterval.count({ where: { userId: bob.id } })) === 0,
  );

  const recomputed = await postActivity(
    aliceDevice.accessToken,
    interval({ keyboardActivityCount: 0, mouseActivityCount: 0, activityPercentage: 99 }),
  );
  check(
    "a client-supplied activityPercentage is discarded",
    (recomputed.body.interval as { activityPercentage?: number })?.activityPercentage === 0,
    `got ${(recomputed.body.interval as { activityPercentage?: number })?.activityPercentage}`,
  );

  const calibrated = await postActivity(
    aliceDevice.accessToken,
    // 60 events in 60s against the default 120/minute is half of "fully active".
    interval({ keyboardActivityCount: 30, mouseActivityCount: 30 }),
  );
  check(
    "the percentage is computed from the counts and the server's rate",
    (calibrated.body.interval as { activityPercentage?: number })?.activityPercentage === 50,
    `got ${(calibrated.body.interval as { activityPercentage?: number })?.activityPercentage}`,
  );

  /* --- authentication ---------------------------------------------------- */
  section("Monitor authentication");

  check(
    "no token is refused",
    (await postActivity(null, interval())).status === 401,
  );
  check(
    "an invalid token is refused",
    (await postActivity("not-a-real-token", interval())).status === 401,
  );

  const revoked = await connectDevice(alice.id);
  await prisma.monitorDevice.update({
    where: { id: revoked.id },
    data: { revokedAt: new Date(), accessTokenHash: null, accessExpiresAt: null },
  });
  check(
    "a revoked device is refused",
    (await postActivity(revoked.accessToken, interval())).status === 401,
  );

  const expired = await connectDevice(alice.id);
  await prisma.monitorDevice.update({
    where: { id: expired.id },
    data: { accessExpiresAt: new Date(Date.now() - 1000) },
  });
  check(
    "an expired access token is refused",
    (await postActivity(expired.accessToken, interval())).status === 401,
  );

  const adminDevice = await connectDevice(admin.id);
  check(
    "an administrator's device is refused (the Monitor is for agents)",
    (await postActivity(adminDevice.accessToken, interval())).status === 401,
  );

  await prisma.user.update({ where: { id: bob.id }, data: { isActive: false } });
  check(
    "a disabled account's device is refused",
    (await postActivity(bobDevice.accessToken, interval())).status === 401,
  );
  await prisma.user.update({ where: { id: bob.id }, data: { isActive: true } });

  /* --- the work session is the authority --------------------------------- */
  section("The work session remains authoritative");

  const noShift = await connectDevice(bob.id);
  const refused = await postActivity(noShift.accessToken, interval());
  check(
    "activity with no open shift is refused with 409",
    refused.status === 409,
    `status ${refused.status}`,
  );
  check(
    "…naming the reason",
    refused.body.error === "no_active_work_session",
    String(refused.body.error),
  );
  check(
    "…and no work session was fabricated to receive it",
    (await prisma.workSession.count({ where: { userId: bob.id } })) === 0,
  );

  const workSessionsAfter = await prisma.workSession.count();
  check(
    "submitting activity created no work sessions at all",
    workSessionsAfter === workSessionsBefore,
    `${workSessionsBefore} -> ${workSessionsAfter}`,
  );

  const shiftNow = await prisma.workSession.findUnique({
    where: { id: aliceShift.id },
    select: { startedAt: true, endedAt: true, durationSeconds: true },
  });
  check(
    "the existing shift's start, end and duration are untouched",
    shiftNow?.endedAt === null && shiftNow?.durationSeconds === null,
  );

  const beat = await postJson("/api/work-session/heartbeat", aliceCookie, {});
  check("the existing work timer still works", beat.status === 200, `status ${beat.status}`);

  /* --- duplicates -------------------------------------------------------- */
  section("Duplicate submissions");

  const retryable = interval();
  const firstDelivery = await postActivity(aliceDevice.accessToken, retryable);
  const secondDelivery = await postActivity(aliceDevice.accessToken, retryable);

  check("the first delivery is created", firstDelivery.status === 201);
  check(
    "the retry is accepted rather than erroring",
    secondDelivery.status === 200,
    `status ${secondDelivery.status}`,
  );
  check("the retry is reported as a duplicate", secondDelivery.body.duplicate === true);
  check(
    "the retry returns the same row",
    (firstDelivery.body.interval as { id?: string })?.id ===
      (secondDelivery.body.interval as { id?: string })?.id,
  );
  check(
    "only one row exists for that key",
    (await prisma.activityInterval.count({
      where: { workSessionId: aliceShift.id, clientKey: retryable.clientKey as string },
    })) === 1,
  );

  // A retry whose counts differ: first write wins, visibly.
  const changed = await postActivity(aliceDevice.accessToken, {
    ...retryable,
    keyboardActivityCount: 999,
  });
  check(
    "a retry with different counts does not overwrite the stored row",
    (changed.body.interval as { keyboardActivityCount?: number })?.keyboardActivityCount === 40,
    `got ${(changed.body.interval as { keyboardActivityCount?: number })?.keyboardActivityCount}`,
  );

  /* --- implausible values ------------------------------------------------ */
  section("Unreasonable values are refused");

  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["an interval that ends before it starts", interval({ endedAt: new Date(Date.now() - 120_000).toISOString() }), 422],
    ["an interval shorter than 10 seconds", interval({}, 5), 422],
    ["an interval longer than twice the cadence", interval({}, 600), 422],
    [
      "a window that ends in the future",
      {
        startedAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        endedAt: new Date(Date.now() + 3 * 60 * 60 * 1000 + 60_000).toISOString(),
        keyboardActivityCount: 1,
        mouseActivityCount: 1,
        clientKey: `future-${randomBytes(6).toString("hex")}`,
      },
      422,
    ],
    [
      "a window from hours ago",
      {
        startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        endedAt: new Date(Date.now() - 5 * 60 * 60 * 1000 + 60_000).toISOString(),
        keyboardActivityCount: 1,
        mouseActivityCount: 1,
        clientKey: `old-${randomBytes(6).toString("hex")}`,
      },
      422,
    ],
    ["an implausible event count", interval({ keyboardActivityCount: 5_000_000 }), 422],
    ["a negative event count", interval({ mouseActivityCount: -5 }), 400],
    ["a fractional event count", interval({ keyboardActivityCount: 1.5 }), 400],
    ["a missing client key", interval({ clientKey: undefined }), 400],
    ["a client key with markup in it", interval({ clientKey: "<script>alert(1)</script>" }), 400],
    ["unparseable timestamps", interval({ startedAt: "yesterday afternoon" }), 400],
  ];

  for (const [name, payload, expected] of cases) {
    const reply = await postActivity(aliceDevice.accessToken, payload);
    check(name, reply.status === expected, `status ${reply.status}, wanted ${expected}`);
  }

  // An interval that starts before the shift it would be attached to.
  const beforeShift = await postActivity(
    aliceDevice.accessToken,
    interval({
      startedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 89 * 60 * 1000).toISOString(),
    }),
  );
  check(
    "an interval starting before its work session is refused",
    beforeShift.status === 422,
    `status ${beforeShift.status}`,
  );

  /* --- permissions ------------------------------------------------------- */
  section("Permissions");

  const own = await get("/api/time-tracking/me", aliceCookie);
  check("an agent can read their own tracking", own.status === 200, `status ${own.status}`);
  check(
    "…and it shows their own activity",
    typeof own.body.todaySeconds === "number" && own.body.activityPercentage !== undefined,
  );
  check(
    "…and carries no screenshot ids",
    JSON.stringify(own.body).includes("screenshots") &&
      !JSON.stringify(own.body).includes("storageKey"),
  );

  const agentAtDashboard = await get("/api/reports/time", aliceCookie);
  check(
    "an agent cannot read the admin dashboard",
    agentAtDashboard.status === 403,
    `status ${agentAtDashboard.status}`,
  );
  check(
    "an agent cannot read another agent's detail",
    (await get(`/api/reports/time/${bob.id}`, aliceCookie)).status === 403,
  );
  check(
    "an agent cannot read timesheets",
    (await get("/api/reports/timesheets", aliceCookie)).status === 403,
  );
  check(
    "an agent cannot read the correction audit trail",
    (await get("/api/time-adjustments", aliceCookie)).status === 403,
  );
  check(
    "an agent cannot make a correction",
    (
      await postJson("/api/time-adjustments", aliceCookie, {
        workSessionId: aliceFinished.id,
        endedAt: new Date().toISOString(),
        reason: "should never be applied",
      })
    ).status === 403,
  );
  check(
    "a signed-out caller cannot make a correction",
    (
      await postJson("/api/time-adjustments", undefined, {
        workSessionId: aliceFinished.id,
        reason: "no session at all",
      })
    ).status === 401,
  );
  check(
    "another agent cannot see Alice's tracking through their own endpoint",
    ((await get("/api/time-tracking/me", bobCookie)).body.todaySeconds ?? 0) === 0,
  );

  const dashboard = await get("/api/reports/time", adminCookie);
  check("an admin can read the dashboard", dashboard.status === 200, `status ${dashboard.status}`);
  check(
    "…and it lists the team",
    Array.isArray(dashboard.body.employees) &&
      (dashboard.body.employees as unknown[]).length >= 3,
  );
  check(
    "an admin can read an employee's detail",
    (await get(`/api/reports/time/${alice.id}`, adminCookie)).status === 200,
  );
  check(
    "an admin can read timesheets",
    (await get("/api/reports/timesheets", adminCookie)).status === 200,
  );

  /* --- corrections ------------------------------------------------------- */
  section("Manual corrections");

  const corrected = await postJson("/api/time-adjustments", adminCookie, {
    workSessionId: aliceFinished.id,
    endedAt: new Date(finishedEnd.getTime() + 60 * 60 * 1000).toISOString(),
    reason: "Laptop crashed; agent confirmed working an extra hour.",
  });
  check("an admin can correct a finished session", corrected.status === 201, `status ${corrected.status}`);

  const sessionAfter = await prisma.workSession.findUnique({
    where: { id: aliceFinished.id },
    select: { durationSeconds: true, endedReason: true },
  });
  check(
    "the session's duration was updated",
    sessionAfter?.durationSeconds === 3 * 60 * 60,
    `got ${sessionAfter?.durationSeconds}`,
  );
  check("the session is marked as adjusted", sessionAfter?.endedReason === "adjusted");

  const audit = await prisma.timeAdjustment.findFirst({
    where: { workSessionId: aliceFinished.id },
  });
  check("an audit record was created", audit !== null);
  check("…naming the administrator", audit?.adminId === admin.id);
  check("…and the affected agent", audit?.userId === alice.id);
  check(
    "…and keeping the previous duration",
    audit?.previousDurationSeconds === 2 * 60 * 60,
    `got ${audit?.previousDurationSeconds}`,
  );
  check("…and the new one", audit?.newDurationSeconds === 3 * 60 * 60);
  check("…and the reason", (audit?.reason ?? "").startsWith("Laptop crashed"));

  check(
    "a correction with no reason is refused",
    (
      await postJson("/api/time-adjustments", adminCookie, {
        workSessionId: aliceFinished.id,
        endedAt: new Date().toISOString(),
        reason: "",
      })
    ).status === 400,
  );
  check(
    "a correction that ends before it starts is refused",
    (
      await postJson("/api/time-adjustments", adminCookie, {
        workSessionId: aliceFinished.id,
        endedAt: new Date(finishedStart.getTime() - 1000).toISOString(),
        reason: "backwards on purpose",
      })
    ).status === 422,
  );
  check(
    "an open session cannot be corrected",
    (
      await postJson("/api/time-adjustments", adminCookie, {
        workSessionId: aliceShift.id,
        endedAt: new Date().toISOString(),
        reason: "still running",
      })
    ).status === 409,
  );
  check(
    "a correction to a session that does not exist is a 404",
    (
      await postJson("/api/time-adjustments", adminCookie, {
        workSessionId: "nosuchsessionid",
        endedAt: new Date().toISOString(),
        reason: "nothing to correct",
      })
    ).status === 404,
  );

  const trail = await get("/api/time-adjustments", adminCookie);
  check(
    "the audit trail is readable by an admin",
    trail.status === 200 && Array.isArray(trail.body.adjustments),
  );

  /* --- the existing monitor API ------------------------------------------ */
  section("The existing Monitor API still works");

  const monitorSession = await fetch(`${BASE_URL}/api/monitor/session`, {
    headers: { authorization: `Bearer ${aliceDevice.accessToken}` },
  });
  const monitorBody = (await monitorSession.json()) as Record<string, unknown>;
  check("GET /api/monitor/session still answers", monitorSession.status === 200);
  check(
    "…still carries the screenshot cadence",
    typeof (monitorBody.screenshotPolicy as { minIntervalSeconds?: number })
      ?.minIntervalSeconds === "number",
  );
  check(
    "…and now carries the activity policy",
    typeof (monitorBody.activityPolicy as { intervalSeconds?: number })?.intervalSeconds ===
      "number",
  );
  check(
    "…and still reports the shift without changing it",
    (monitorBody.workSession as { id?: string })?.id === aliceShift.id,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Remove everything this run created.
 *
 * Ordered so foreign keys are satisfied without relying on cascade rules being
 * what they are today: adjustments, then intervals, then screenshots, then the
 * shifts, then the devices and sessions, then the accounts. `time_adjustments`
 * holds `Restrict` on its admin, which is exactly the constraint a real audit
 * trail should have and exactly the one a cleanup has to respect.
 */
async function cleanup(): Promise<void> {
  if (created.length === 0) return;

  await prisma.timeAdjustment.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.timeAdjustment.deleteMany({ where: { adminId: { in: created } } }).catch(() => {});
  await prisma.activityInterval.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.screenshot.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.workSession.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.monitorDevice.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
}

main()
  .catch((error) => {
    console.error("\nThe run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
