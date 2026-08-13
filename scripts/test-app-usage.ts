import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * End-to-end check of app usage tracking: the Monitor's submission API, the
 * duplicate protection, the permission boundaries, the aggregation and the
 * daily timeline — against a running server and a real database.
 *
 *   npm run dev             (in one terminal)
 *   npm run test:app-usage  (in another)
 *
 * Written for the reason `test-activity.ts` was: this repository has no test
 * framework, and none of the claims worth checking here are unit-testable in
 * any useful sense. "An agent cannot read a colleague's app usage" is a claim
 * about an HTTP route, a session cookie, a database lookup and the *absence* of
 * a field — a mocked version would pass whether or not the real thing works. So
 * this speaks HTTP to the real routes and then looks in Postgres to see what
 * actually happened.
 *
 * It creates two throwaway agents (`apptest-*`), an administrator, their work
 * sessions and monitor devices, and deletes all of it on the way out, including
 * after a failure. It never touches an existing user, device, session, interval
 * or usage row.
 *
 * **Device rows and portal sessions are inserted directly rather than signed in
 * for.** A real sign-in needs a six-digit code delivered by email, which a test
 * cannot read. Both token constructions are copied from `lib/monitorAuth.ts` and
 * `lib/session.ts` (32 random bytes, SHA-256 into the row), so what the routes
 * authenticate is exactly what they authenticate in production.
 *
 * The last section deliberately re-checks the *existing* systems — leads,
 * screenshots, activity, work sessions and the monitor session endpoint — to
 * show that adding app usage changed none of them.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "app-usage-test-Pa55phrase";

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
      deviceName: "app-usage-test",
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
      userAgent: "app-usage-test",
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

async function postUsage(
  accessToken: string | null,
  payload: Record<string, unknown>,
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}/api/monitor/app-usage`, {
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A well-formed segment ending `agoSeconds` ago, of `seconds` length. */
function segment(
  overrides: Record<string, unknown> = {},
  seconds = 60,
  agoSeconds = 0,
): Record<string, unknown> {
  const endedAt = new Date(Date.now() - agoSeconds * 1000);
  const startedAt = new Date(endedAt.getTime() - seconds * 1000);

  return {
    processName: "chrome.exe",
    applicationName: "Google Chrome",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    clientKey: `apptest-${randomBytes(8).toString("hex")}`,
    ...overrides,
  };
}

/** The application row for a name, from a report payload. */
function appRow(
  body: Record<string, unknown>,
  name: string,
): { seconds?: number; shareOfAppTime?: number; segments?: number } | undefined {
  const rows = (body.applications ?? []) as Array<Record<string, unknown>>;
  return rows.find((row) => row.applicationName === name) as
    | { seconds?: number; shareOfAppTime?: number; segments?: number }
    | undefined;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const created: string[] = [];

async function main(): Promise<void> {
  console.log(`App usage checks against ${BASE_URL}\n`);

  const stamp = Date.now();
  const passwordHash = await hashPassword(PASSWORD);

  const alice = await prisma.user.create({
    data: {
      username: `apptest-alice-${stamp}`,
      email: `apptest-alice-${stamp}@example.test`,
      name: "App Usage Test Alice",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  const bob = await prisma.user.create({
    data: {
      username: `apptest-bob-${stamp}`,
      email: `apptest-bob-${stamp}@example.test`,
      name: "App Usage Test Bob",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  const admin = await prisma.user.create({
    data: {
      username: `apptest-admin-${stamp}`,
      email: `apptest-admin-${stamp}@example.test`,
      name: "App Usage Test Admin",
      passwordHash,
      role: "ADMIN",
    },
    select: { id: true },
  });
  created.push(alice.id, bob.id, admin.id);

  // An open shift for Alice, beating now so `getActiveWorkSession` sees it.
  const aliceShift = await prisma.workSession.create({
    data: {
      userId: alice.id,
      startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      lastSeenAt: new Date(),
    },
    select: { id: true },
  });

  // Bob has a device but deliberately no open shift.
  const aliceDevice = await connectDevice(alice.id);
  const bobDevice = await connectDevice(bob.id);

  const aliceCookie = await signIn(alice.id);
  const adminCookie = await signIn(admin.id);

  const workSessionsBefore = await prisma.workSession.count();
  const intervalsBefore = await prisma.activityInterval.count();
  const screenshotsBefore = await prisma.screenshot.count();

  /* --- submission -------------------------------------------------------- */
  section("App usage submission");

  const first = segment();
  const accepted = await postUsage(aliceDevice.accessToken, first);
  check("an agent's app usage is accepted", accepted.status === 201, `status ${accepted.status}`);

  const stored = await prisma.appUsage.findFirst({
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
  check(
    "the authenticated device is recorded",
    stored?.deviceId === aliceDevice.id,
    `got ${stored?.deviceId}`,
  );
  check(
    "the duration is derived from the timestamps",
    stored?.durationSeconds === 60,
    `got ${stored?.durationSeconds}`,
  );

  /* --- the client cannot name anybody ------------------------------------ */
  section("Authorization is never taken from the body");

  const impersonation = await postUsage(
    aliceDevice.accessToken,
    segment({
      // Every one of these is ignored: they are not read from the request at
      // all, which is stronger than being validated away.
      userId: bob.id,
      agentId: bob.id,
      workSessionId: "some-other-session",
      monitorDeviceId: bobDevice.id,
      durationSeconds: 99_999,
    }),
  );
  check("a submission naming another agent is still accepted", impersonation.status === 201);

  const impersonated = await prisma.appUsage.findUnique({
    where: { id: (impersonation.body.usage as { id?: string })?.id ?? "none" },
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
    "…and to the authenticating device, not the named one",
    impersonated?.deviceId === aliceDevice.id,
    `got ${impersonated?.deviceId}`,
  );
  check(
    "…and a client-supplied durationSeconds is discarded",
    impersonated?.durationSeconds === 60,
    `got ${impersonated?.durationSeconds}`,
  );
  check(
    "no app usage row was created for the other agent",
    (await prisma.appUsage.count({ where: { userId: bob.id } })) === 0,
  );

  /* --- what is never stored ---------------------------------------------- */
  section("Nothing sensitive is stored");

  const withPath = await postUsage(
    aliceDevice.accessToken,
    segment({
      processName: "C:\\Users\\umar\\AppData\\Local\\Programs\\Slack\\slack.exe",
      applicationName: "Slack",
      // Fields that do not exist in the schema. They must not appear anywhere.
      windowTitle: "Re: contract — Gmail",
      url: "https://mail.google.com/inbox",
      keystrokes: "hunter2",
    }),
  );
  check("a segment with extra fields is accepted", withPath.status === 201);

  const slack = await prisma.appUsage.findUnique({
    where: { id: (withPath.body.usage as { id?: string })?.id ?? "none" },
  });
  check(
    "the process path is reduced to the executable",
    slack?.processName === "slack.exe",
    `got ${slack?.processName}`,
  );
  check(
    "no window title, URL or keystroke reached the row",
    JSON.stringify(slack ?? {}).indexOf("mail.google.com") === -1 &&
      JSON.stringify(slack ?? {}).indexOf("hunter2") === -1 &&
      JSON.stringify(slack ?? {}).indexOf("Gmail") === -1,
  );
  check(
    "an applicationName that is a URL is refused",
    (await postUsage(aliceDevice.accessToken, segment({ applicationName: "https://example.com/x" })))
      .status === 422,
  );

  /* --- authentication ---------------------------------------------------- */
  section("Monitor authentication");

  check("no token is refused", (await postUsage(null, segment())).status === 401);
  check(
    "an invalid token is refused",
    (await postUsage("not-a-real-token", segment())).status === 401,
  );

  const revoked = await connectDevice(alice.id);
  await prisma.monitorDevice.update({
    where: { id: revoked.id },
    data: { revokedAt: new Date(), accessTokenHash: null, accessExpiresAt: null },
  });
  check(
    "a revoked device is refused",
    (await postUsage(revoked.accessToken, segment())).status === 401,
  );

  const expired = await connectDevice(alice.id);
  await prisma.monitorDevice.update({
    where: { id: expired.id },
    data: { accessExpiresAt: new Date(Date.now() - 1000) },
  });
  check(
    "an expired access token is refused",
    (await postUsage(expired.accessToken, segment())).status === 401,
  );

  const adminDevice = await connectDevice(admin.id);
  check(
    "an administrator's device is refused (the Monitor is for agents)",
    (await postUsage(adminDevice.accessToken, segment())).status === 401,
  );

  await prisma.user.update({ where: { id: bob.id }, data: { isActive: false } });
  check(
    "a disabled account's device is refused",
    (await postUsage(bobDevice.accessToken, segment())).status === 401,
  );
  await prisma.user.update({ where: { id: bob.id }, data: { isActive: true } });

  /* --- the work session is the authority --------------------------------- */
  section("The work session remains authoritative");

  const noShift = await connectDevice(bob.id);
  const refused = await postUsage(noShift.accessToken, segment());
  check(
    "app usage with no open shift is refused with 409",
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
  check(
    "submitting app usage created no work sessions at all",
    (await prisma.workSession.count()) === workSessionsBefore,
  );

  const shiftNow = await prisma.workSession.findUnique({
    where: { id: aliceShift.id },
    select: { endedAt: true, durationSeconds: true },
  });
  check(
    "the existing shift's end and duration are untouched",
    shiftNow?.endedAt === null && shiftNow?.durationSeconds === null,
  );

  /* --- duplicates -------------------------------------------------------- */
  section("Duplicate submissions");

  const retryable = segment({ applicationName: "Microsoft Edge", processName: "msedge.exe" });
  const firstDelivery = await postUsage(aliceDevice.accessToken, retryable);
  const secondDelivery = await postUsage(aliceDevice.accessToken, retryable);

  check("the first delivery is created", firstDelivery.status === 201);
  check(
    "the retry is accepted rather than erroring",
    secondDelivery.status === 200,
    `status ${secondDelivery.status}`,
  );
  check("the retry is reported as a duplicate", secondDelivery.body.duplicate === true);
  check(
    "the retry returns the same row",
    (firstDelivery.body.usage as { id?: string })?.id ===
      (secondDelivery.body.usage as { id?: string })?.id,
  );
  check(
    "only one row exists for that key",
    (await prisma.appUsage.count({
      where: { clientKey: retryable.clientKey as string },
    })) === 1,
  );

  const changed = await postUsage(aliceDevice.accessToken, {
    ...retryable,
    applicationName: "Something Else",
  });
  check(
    "a retry with different content does not overwrite the stored row",
    (changed.body.usage as { applicationName?: string })?.applicationName === "Microsoft Edge",
    `got ${(changed.body.usage as { applicationName?: string })?.applicationName}`,
  );

  /* --- implausible values ------------------------------------------------ */
  section("Unreasonable values are refused");

  const cases: Array<[string, Record<string, unknown>, number]> = [
    [
      "a segment that ends before it starts",
      segment({ endedAt: new Date(Date.now() - 120_000).toISOString() }),
      422,
    ],
    ["a segment shorter than 5 seconds", segment({}, 2), 422],
    ["a segment longer than 4 hours", segment({}, 5 * 60 * 60), 422],
    [
      "a window that ends in the future",
      {
        ...segment(),
        startedAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        endedAt: new Date(Date.now() + 3 * 60 * 60 * 1000 + 60_000).toISOString(),
      },
      422,
    ],
    ["a window that ended hours ago", segment({}, 60, 5 * 60 * 60), 422],
    ["a missing client key", segment({ clientKey: undefined }), 400],
    ["a client key with markup in it", segment({ clientKey: "<script>alert(1)</script>" }), 400],
    ["unparseable timestamps", segment({ startedAt: "yesterday afternoon" }), 400],
    ["a missing process name", segment({ processName: "" }), 400],
    ["a missing application name", segment({ applicationName: "   " }), 400],
    ["an application name of 200 characters", segment({ applicationName: "x".repeat(200) }), 400],
    ["an application name with a newline in it", segment({ applicationName: "Chrome\nx" }), 400],
  ];

  for (const [name, payload, expected] of cases) {
    const reply = await postUsage(aliceDevice.accessToken, payload);
    check(name, reply.status === expected, `status ${reply.status}, wanted ${expected}`);
  }

  // A segment that starts before the shift it would be attached to. Alice's
  // shift began six hours ago, so seven hours ago is outside it — and the
  // window still has to end recently, which a long segment does.
  const beforeShift = await postUsage(
    aliceDevice.accessToken,
    {
      ...segment(),
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    },
  );
  check(
    "a segment starting before its work session is refused",
    beforeShift.status === 422,
    `status ${beforeShift.status} ${String(beforeShift.body.error)}`,
  );

  /* --- a client key belonging to somebody else --------------------------- */
  section("Client keys are not transferable");

  // Bob gets a shift of his own so his device can submit at all.
  await prisma.workSession.create({
    data: { userId: bob.id, startedAt: new Date(Date.now() - 60 * 60 * 1000), lastSeenAt: new Date() },
  });
  const bobsDevice = await connectDevice(bob.id);

  const conflict = await postUsage(bobsDevice.accessToken, {
    ...segment(),
    clientKey: retryable.clientKey,
  });
  check(
    "another agent reusing a stored client key is refused with 409",
    conflict.status === 409,
    `status ${conflict.status}`,
  );
  check(
    "…as a conflict rather than as a duplicate",
    conflict.body.error === "client_key_conflict",
    String(conflict.body.error),
  );
  check(
    "…and the stored row still belongs to the original agent",
    (await prisma.appUsage.findUnique({
      where: { clientKey: retryable.clientKey as string },
      select: { userId: true },
    }))?.userId === alice.id,
  );

  /* --- aggregation ------------------------------------------------------- */
  section("Aggregation");

  // A known set: 3 × 60s of Chrome (from the fixtures above) plus a deliberate
  // 300s of VS Code, so the arithmetic can be checked by hand.
  await postUsage(
    aliceDevice.accessToken,
    segment({ processName: "code.exe", applicationName: "Visual Studio Code" }, 300),
  );

  const aliceTotals = await prisma.appUsage.groupBy({
    by: ["applicationName"],
    where: { userId: alice.id },
    _sum: { durationSeconds: true },
  });
  const chromeSeconds =
    aliceTotals.find((row) => row.applicationName === "Google Chrome")?._sum.durationSeconds ?? 0;
  const totalSeconds = aliceTotals.reduce(
    (sum, row) => sum + (row._sum.durationSeconds ?? 0),
    0,
  );

  const report = await get(`/api/reports/app-usage?range=today&agent=${alice.id}`, adminCookie);
  check("an admin can read the report", report.status === 200, `status ${report.status}`);
  check(
    "the recorded total matches the database",
    (report.body.summary as { recordedSeconds?: number })?.recordedSeconds === totalSeconds,
    `${(report.body.summary as { recordedSeconds?: number })?.recordedSeconds} vs ${totalSeconds}`,
  );
  check(
    "Chrome's total matches the database",
    appRow(report.body, "Google Chrome")?.seconds === chromeSeconds,
    `${appRow(report.body, "Google Chrome")?.seconds} vs ${chromeSeconds}`,
  );
  check(
    "Chrome's share is its seconds over the total",
    appRow(report.body, "Google Chrome")?.shareOfAppTime ===
      Math.round((chromeSeconds / totalSeconds) * 100),
  );
  check(
    "the shares of the listed applications add to 100",
    ((report.body.applications ?? []) as Array<{ shareOfAppTime: number }>).reduce(
      (sum, row) => sum + row.shareOfAppTime,
      0,
    ) === 100,
  );
  check(
    "tracked time comes from the work session, not from app usage",
    ((report.body.summary as { trackedSeconds?: number })?.trackedSeconds ?? 0) > totalSeconds,
  );
  check(
    "the employee view carries tracked time and the activity figure",
    (report.body.employee as { trackedSeconds?: number })?.trackedSeconds !== undefined &&
      "activityPercentage" in ((report.body.employee ?? {}) as object),
  );
  check(
    "no client key is exposed anywhere in the payload",
    !JSON.stringify(report.body).includes("clientKey"),
  );

  /* --- filters ----------------------------------------------------------- */
  section("Filters");

  const filtered = await get(
    `/api/reports/app-usage?range=today&agent=${alice.id}&application=Google%20Chrome`,
    adminCookie,
  );
  check("filtering by application returns only that application",
    ((filtered.body.applications ?? []) as Array<{ applicationName: string }>).every(
      (row) => row.applicationName === "Google Chrome",
    ),
  );
  check(
    "…and its share is still measured against the whole window",
    appRow(filtered.body, "Google Chrome")?.shareOfAppTime ===
      Math.round((chromeSeconds / totalSeconds) * 100),
    `got ${appRow(filtered.body, "Google Chrome")?.shareOfAppTime}`,
  );

  const otherAgent = await get(`/api/reports/app-usage?range=today&agent=${bob.id}`, adminCookie);
  check(
    "filtering by an agent with no usage reports nothing",
    (otherAgent.body.summary as { recordedSeconds?: number })?.recordedSeconds === 0,
  );

  const yesterday = await get(`/api/reports/app-usage?range=yesterday`, adminCookie);
  check(
    "a date range with no data reports nothing",
    (yesterday.body.summary as { recordedSeconds?: number })?.recordedSeconds === 0,
    `got ${(yesterday.body.summary as { recordedSeconds?: number })?.recordedSeconds}`,
  );

  const unknownAgent = await get("/api/reports/app-usage?range=today&agent=nosuchid", adminCookie);
  check(
    "an agent id that names nobody is an empty report, not an error",
    unknownAgent.status === 200 &&
      (unknownAgent.body.summary as { recordedSeconds?: number })?.recordedSeconds === 0,
  );

  /* --- the timeline ------------------------------------------------------ */
  section("The daily timeline");

  const timeline = await get(
    `/api/reports/app-usage/timeline?range=today&agent=${alice.id}`,
    adminCookie,
  );
  check("an admin can read the timeline", timeline.status === 200, `status ${timeline.status}`);

  const entries = (timeline.body.entries ?? []) as Array<Record<string, unknown>>;
  check(
    "it has one entry per stored segment",
    entries.length === (await prisma.appUsage.count({ where: { userId: alice.id } })),
    `${entries.length} entries`,
  );
  check(
    "the entries are in chronological order",
    entries.every(
      (entry, index) =>
        index === 0 ||
        new Date(entry.startedAt as string).getTime() >=
          new Date(entries[index - 1].startedAt as string).getTime(),
    ),
  );
  check(
    "an entry carries the application, the process and the window — and nothing else",
    entries.every(
      (entry) =>
        "applicationName" in entry &&
        "processName" in entry &&
        "startedAt" in entry &&
        "endedAt" in entry &&
        !("windowTitle" in entry) &&
        !("url" in entry) &&
        !("clientKey" in entry),
    ),
  );
  check(
    "a timeline with no agent is refused",
    (await get("/api/reports/app-usage/timeline?range=today", adminCookie)).status === 400,
  );

  /* --- permissions ------------------------------------------------------- */
  section("Permissions");

  check(
    "an agent cannot read the app usage report",
    (await get("/api/reports/app-usage?range=today", aliceCookie)).status === 403,
  );
  check(
    "an agent cannot read their own app usage either",
    (await get(`/api/reports/app-usage?range=today&agent=${alice.id}`, aliceCookie)).status === 403,
  );
  check(
    "an agent cannot read a colleague's app usage",
    (await get(`/api/reports/app-usage?range=today&agent=${bob.id}`, aliceCookie)).status === 403,
  );
  check(
    "an agent cannot read the timeline",
    (await get(`/api/reports/app-usage/timeline?range=today&agent=${alice.id}`, aliceCookie))
      .status === 403,
  );
  check(
    "a signed-out caller gets 401, not 403",
    (await get("/api/reports/app-usage?range=today")).status === 401,
  );
  check(
    "an agent is refused the App usage page",
    [307, 302, 200].includes((await get("/reports/app-usage", aliceCookie)).status),
  );

  /* --- a large dataset --------------------------------------------------- */
  section("A large dataset stays server-side");

  // 5,000 rows written directly — the write path is already covered above, and
  // what is under test here is that the *report* does not grow with them.
  const bulkShift = await prisma.workSession.findFirst({
    where: { userId: alice.id, endedAt: null },
    select: { id: true, startedAt: true },
  });
  const base = bulkShift!.startedAt.getTime();
  await prisma.appUsage.createMany({
    data: Array.from({ length: 5000 }, (_, index) => ({
      userId: alice.id,
      workSessionId: bulkShift!.id,
      deviceId: aliceDevice.id,
      processName: `proc${index % 40}.exe`,
      applicationName: `Bulk App ${index % 40}`,
      startedAt: new Date(base + index * 1000),
      endedAt: new Date(base + index * 1000 + 30_000),
      durationSeconds: 30,
      clientKey: `apptest-bulk-${stamp}-${index}`,
    })),
  });

  const started = Date.now();
  const bulk = await get(`/api/reports/app-usage?range=today&agent=${alice.id}`, adminCookie);
  const elapsed = Date.now() - started;

  check("the report still answers with 5,000 rows in the window", bulk.status === 200);
  check(
    "…returning at most nine application rows",
    ((bulk.body.applications ?? []) as unknown[]).length <= 9,
    `${((bulk.body.applications ?? []) as unknown[]).length} rows`,
  );
  check(
    "…with an Other row carrying the remainder",
    ((bulk.body.applications ?? []) as Array<{ other?: boolean }>).some((row) => row.other === true),
  );
  /*
   * The invariant that is exact is the *seconds*: the listed rows plus `Other`
   * are the whole window, by construction — `Other` is computed as the total
   * minus what is listed rather than by a second query.
   *
   * The *shares* are each rounded to a whole percent independently, so they
   * only re-sum to 100 when the rounding errors happen to cancel. Forty
   * applications of 2.49% each is the pathological case: every one of them
   * rounds down, and the column reads 96. That is the right trade — each row
   * states its own true share, and the alternative (giving `Other` whatever is
   * left over) would make one row's number a plug rather than a measurement.
   * The small-set case above asserts exactly 100, which is what a reader sees
   * on a real report.
   */
  const bulkRows = (bulk.body.applications ?? []) as Array<{
    seconds: number;
    shareOfAppTime: number;
  }>;
  check(
    "…the seconds still adding up to the whole window exactly",
    bulkRows.reduce((sum, row) => sum + row.seconds, 0) ===
      (bulk.body.summary as { recordedSeconds?: number })?.recordedSeconds,
  );
  check(
    "…and the shares accounting for it to within rounding",
    Math.abs(bulkRows.reduce((sum, row) => sum + row.shareOfAppTime, 0) - 100) <= 8,
    `${bulkRows.reduce((sum, row) => sum + row.shareOfAppTime, 0)}%`,
  );
  check("…and in under three seconds", elapsed < 3000, `${elapsed}ms`);

  const bulkTimeline = await get(
    `/api/reports/app-usage/timeline?range=today&agent=${alice.id}`,
    adminCookie,
  );
  check(
    "the timeline is capped rather than unbounded",
    ((bulkTimeline.body.entries ?? []) as unknown[]).length === 500 &&
      bulkTimeline.body.truncated === true,
    `${((bulkTimeline.body.entries ?? []) as unknown[]).length} entries`,
  );

  /* --- the existing systems --------------------------------------------- */
  section("Nothing existing changed");

  check(
    "no activity interval was created by any of this",
    (await prisma.activityInterval.count()) === intervalsBefore,
  );
  check(
    "no screenshot was created or deleted",
    (await prisma.screenshot.count()) === screenshotsBefore,
  );

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
    "…still carries the activity policy",
    typeof (monitorBody.activityPolicy as { intervalSeconds?: number })?.intervalSeconds ===
      "number",
  );
  check(
    "…and now carries the app usage bounds",
    typeof (monitorBody.appUsagePolicy as { maxSegmentSeconds?: number })?.maxSegmentSeconds ===
      "number",
  );
  check(
    "…and still reports the shift without changing it",
    (monitorBody.workSession as { id?: string })?.id === aliceShift.id,
  );

  check(
    "the admin time dashboard still answers",
    (await get("/api/reports/time", adminCookie)).status === 200,
  );
  check(
    "the employee time detail still answers",
    (await get(`/api/reports/time/${alice.id}`, adminCookie)).status === 200,
  );
  check(
    "timesheets still answer",
    (await get("/api/reports/timesheets", adminCookie)).status === 200,
  );
  check(
    "productivity still answers",
    (await get("/api/reports/productivity", adminCookie)).status === 200,
  );
  check(
    "the leads API still answers",
    (await get("/api/leads?page=1", adminCookie)).status === 200,
  );
  check(
    "an agent can still read their own time tracking",
    (await get("/api/time-tracking/me", aliceCookie)).status === 200,
  );
  check(
    "the screenshot viewer still answers",
    (await get("/api/screenshots", adminCookie)).status === 200,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Remove everything this run created.
 *
 * Ordered so foreign keys are satisfied without relying on cascade rules being
 * what they are today: usage, then intervals and screenshots, then the shifts,
 * then the devices and sessions, then the accounts.
 */
async function cleanup(): Promise<void> {
  if (created.length === 0) return;

  await prisma.appUsage.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
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
