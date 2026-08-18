import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * End-to-end check of work-session liveness: that a hidden, minimised or closed
 * Leads Portal tab no longer closes the shift of an agent whose SpiderHunts
 * Monitor is still watching their workstation — and that nothing else about
 * work sessions has been loosened to achieve it.
 *
 *   npm run dev                        (in one terminal)
 *   npm run test:work-session-liveness (in another)
 *
 * Written for the reason `test-activity.ts` and `test-app-usage.ts` were: this
 * repository has no test framework, and none of the claims worth checking here
 * are unit-testable in any useful sense. "A minimised browser does not end a
 * monitored shift" is a claim about an HTTP route, a bearer token, a database
 * predicate and the *absence* of a second row — a mocked version would pass
 * whether or not the real thing works. So this speaks HTTP to the real routes
 * and then looks in Postgres to see what actually happened.
 *
 * ---------------------------------------------------------------------------
 * How time passes in here
 * ---------------------------------------------------------------------------
 * The grace window is half an hour, and a test may not sleep for it. Time is
 * therefore moved by ageing the row: `last_seen_at` is pushed into the past to
 * mean "this tab has been hidden for over half an hour", which is exactly the
 * state a hidden tab produces — it stops beating, and the column stops moving.
 * Every ageing below is expressed against `STALE_MS` rather than as a literal,
 * so widening the window again does not silently turn these into no-ops. Nothing
 * about the code under test is stubbed, and the server's own clock is still the
 * only clock any decision is made on.
 *
 * `last_monitor_seen_at` is aged the same way in the places where the point is
 * to prove the *Monitor* has gone quiet, and is nudged past its one-minute
 * write throttle where the point is to prove a poll re-touches it.
 *
 * It creates two throwaway agents (`livetest-*`), an administrator, their work
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
 * screenshots, activity, app usage, the reports and the monitor session
 * endpoint — to show that changing the staleness rule changed none of them.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "liveness-test-Pa55phrase";

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

/**
 * `STALE_MS` in `lib/workSessions.ts`: half an hour of silence on *both*
 * signals. No longer a multiple of the heartbeat — see the note there.
 */
const STALE_MS = 30 * 60 * 1000;
/** `MONITOR_TOUCH_AFTER_MS` in the same file — the write throttle. */
const MONITOR_TOUCH_AFTER_MS = 60 * 1000;

/**
 * An instant far enough back to count as silence, as a multiple of the grace
 * window rather than a literal number of minutes.
 *
 * The window used to be five minutes and is now thirty. Every "this tab went
 * quiet" fixture below was written as `minutesAgo(10)`, which was twice the old
 * window and is a third of the new one — so widening `STALE_MS` would have
 * turned each of them into "this tab is still beating" and quietly inverted the
 * assertion underneath. Deriving them removes that trap for the next change.
 */
const staleBy = (multiple: number) => new Date(Date.now() - STALE_MS * multiple);

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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const created: string[] = [];

async function makeUser(
  suffix: string,
  role: "AGENT" | "ADMIN",
  isActive = true,
): Promise<{ id: string; username: string }> {
  const username = `livetest-${suffix}-${randomBytes(3).toString("hex")}`;
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.invalid`,
      name: `Liveness ${suffix}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive,
    },
    select: { id: true, username: true },
  });

  created.push(user.id);
  return user;
}

/** A monitor device for a user, as `issueDeviceTokens` would have written it. */
async function connectDevice(
  userId: string,
  revoked = false,
): Promise<{ id: string; accessToken: string }> {
  const accessToken = randomBytes(32).toString("base64url");
  const now = Date.now();

  const device = await prisma.monitorDevice.create({
    data: {
      userId,
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: new Date(now + 15 * 60 * 1000),
      refreshTokenHash: hashToken(randomBytes(32).toString("base64url")),
      refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      deviceName: "liveness-test",
      platform: "win32",
      appVersion: "test",
      // Aged, so the device's own `last_seen_at` touch is never the thing under
      // test and never masks a missing work-session write.
      lastSeenAt: minutesAgo(10),
      ...(revoked ? { revokedAt: new Date() } : {}),
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
      userAgent: "liveness-test",
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
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

/** `GET /api/monitor/session` — the Monitor's routine poll. */
async function monitorPoll(accessToken: string | null): Promise<Reply> {
  const response = await fetch(`${BASE_URL}/api/monitor/session`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });

  return { status: response.status, body: await readJson(response) };
}

/** `POST /api/work-session/heartbeat` — the portal tab's beat. */
async function portalBeat(cookie: string): Promise<Reply> {
  const response = await fetch(`${BASE_URL}/api/work-session/heartbeat`, {
    method: "POST",
    headers: { cookie },
  });

  return { status: response.status, body: await readJson(response) };
}

async function postJson(
  path: string,
  accessToken: string | null,
  payload: Record<string, unknown>,
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  return { status: response.status, body: await readJson(response) };
}

async function logout(cookie: string): Promise<number> {
  const response = await fetch(`${BASE_URL}/api/auth/logout`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
  return response.status;
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

function interval(seconds = 60): Record<string, unknown> {
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - seconds * 1000);

  return {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    keyboardActivityCount: 40,
    mouseActivityCount: 20,
    clientKey: `livetest-${randomBytes(8).toString("hex")}`,
  };
}

function segment(seconds = 60): Record<string, unknown> {
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - seconds * 1000);

  return {
    processName: "chrome.exe",
    applicationName: "Google Chrome",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    clientKey: `livetest-${randomBytes(8).toString("hex")}`,
  };
}

/**
 * A JPEG as far as `sniffImage` is concerned: SOI, a comment segment carrying
 * the padding that takes it over the 1KB floor, a start-of-frame stating the
 * dimensions, EOI. Copied from `test-screenshots.ts` rather than shipping a
 * binary fixture into the repository.
 */
function fakeJpeg(width: number, height: number, padding = 2048): Uint8Array<ArrayBuffer> {
  const comment = Buffer.alloc(2 + 2 + padding);
  comment.writeUInt8(0xff, 0);
  comment.writeUInt8(0xfe, 1);
  comment.writeUInt16BE(2 + padding, 2);

  const sof = Buffer.alloc(2 + 2 + 6);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(8 + 3, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9);

  const joined = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    comment,
    sof,
    Buffer.from([0x00, 0x01, 0x11, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);

  return new Uint8Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.length));
}

async function uploadScreenshot(accessToken: string): Promise<Reply> {
  const form = new FormData();
  form.append("file", new Blob([fakeJpeg(1280, 720)], { type: "image/jpeg" }), "shot.jpg");
  form.append("capturedAt", new Date().toISOString());
  form.append("displayId", "1");

  const response = await fetch(`${BASE_URL}/api/monitor/screenshots`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });

  return { status: response.status, body: await readJson(response) };
}

/* -------------------------------------------------------------------------- */
/* Database helpers                                                           */
/* -------------------------------------------------------------------------- */

interface SessionRow {
  id: string;
  startedAt: Date;
  lastSeenAt: Date;
  lastMonitorSeenAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
}

async function openSessionOf(userId: string): Promise<SessionRow | null> {
  return prisma.workSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      startedAt: true,
      lastSeenAt: true,
      lastMonitorSeenAt: true,
      endedAt: true,
      endedReason: true,
    },
  });
}

async function sessionById(id: string): Promise<SessionRow | null> {
  return prisma.workSession.findUnique({
    where: { id },
    select: {
      id: true,
      startedAt: true,
      lastSeenAt: true,
      lastMonitorSeenAt: true,
      endedAt: true,
      endedReason: true,
    },
  });
}

const countSessions = (userId: string) => prisma.workSession.count({ where: { userId } });

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(`\nWork-session liveness — ${BASE_URL}\n`);

  const alice = await makeUser("alice", "AGENT");
  const bob = await makeUser("bob", "AGENT");
  const admin = await makeUser("admin", "ADMIN");

  const aliceDevice = await connectDevice(alice.id);
  const aliceRevoked = await connectDevice(alice.id, true);
  const bobDevice = await connectDevice(bob.id);
  const adminDevice = await connectDevice(admin.id);

  const aliceCookie = await signIn(alice.id);
  const adminCookie = await signIn(admin.id);

  /* ------------------------------------------------------------------------ */
  section("1. The agent starts a shift, and the portal heartbeat keeps it alive");
  /* ------------------------------------------------------------------------ */

  const firstBeat = await portalBeat(aliceCookie);
  check("the portal heartbeat answers", firstBeat.status === 200, `status ${firstBeat.status}`);

  const opened = await openSessionOf(alice.id);
  check("a shift is open", opened !== null);
  if (!opened) throw new Error("no work session was opened — the rest cannot run");

  const shiftId = opened.id;
  check("it has no monitor sighting yet", opened.lastMonitorSeenAt === null);

  /*
   * Backdate the start to 09:00. Not cosmetic: an activity interval or an
   * app-usage segment that begins before its shift did is refused as
   * `outside_work_session` (`lib/activityRules.ts`), so a shift that started
   * two seconds ago can accept nothing, and section 4 below would be testing
   * the timestamp rules rather than session continuity.
   */
  const backdated = await prisma.workSession.update({
    where: { id: shiftId },
    data: { startedAt: minutesAgo(180) },
    select: { startedAt: true },
  });
  const shiftStartedAt = backdated.startedAt.getTime();

  await portalBeat(aliceCookie);
  const afterSecondBeat = await openSessionOf(alice.id);
  check("a second beat keeps the same shift", afterSecondBeat?.id === shiftId);
  check("and creates no second row", (await countSessions(alice.id)) === 1);

  /* ------------------------------------------------------------------------ */
  section("2. A Monitor poll is recorded as liveness");
  /* ------------------------------------------------------------------------ */

  const poll = await monitorPoll(aliceDevice.accessToken);
  const pollSession = poll.body.workSession as Record<string, unknown> | undefined;

  check("the Monitor's poll answers", poll.status === 200, `status ${poll.status}`);
  check("it reports the shift as active", pollSession?.active === true);
  check("and names the same shift", pollSession?.id === shiftId, `got ${String(pollSession?.id)}`);

  const afterPoll = await openSessionOf(alice.id);
  check("the poll recorded a monitor sighting", afterPoll?.lastMonitorSeenAt !== null);
  check("the poll did not move the portal heartbeat", afterPoll?.lastSeenAt.getTime() === afterSecondBeat?.lastSeenAt.getTime());
  check("the poll opened no second shift", (await countSessions(alice.id)) === 1);

  /* ------------------------------------------------------------------------ */
  section("3. The portal tab goes hidden for longer than the stale window");
  /* ------------------------------------------------------------------------ */

  /*
   * The agent minimises the portal at 09:15 and works in Chrome until 11:00.
   * A hidden tab simply stops beating, so `last_seen_at` stops moving — which
   * is what ageing it here reproduces. The Monitor's sighting is nudged past
   * the one-minute write throttle so the next poll is free to re-touch it.
   */
  await prisma.workSession.update({
    where: { id: shiftId },
    data: {
      lastSeenAt: staleBy(2),
      lastMonitorSeenAt: new Date(Date.now() - MONITOR_TOUCH_AFTER_MS - 5000),
    },
  });

  const hiddenPoll = await monitorPoll(aliceDevice.accessToken);
  const hiddenSession = hiddenPoll.body.workSession as Record<string, unknown> | undefined;

  check(
    "the browser heartbeat is well past the grace window — twice over",
    Date.now() - (await sessionById(shiftId))!.lastSeenAt.getTime() > STALE_MS,
  );
  check("the shift is still reported active", hiddenSession?.active === true);
  check("the SAME workSessionId is still active", hiddenSession?.id === shiftId);

  const hidden = await sessionById(shiftId);
  check("the shift row is still open", hidden?.endedAt === null);
  check(
    "the Monitor's poll refreshed the monitor sighting",
    (hidden?.lastMonitorSeenAt?.getTime() ?? 0) > Date.now() - MONITOR_TOUCH_AFTER_MS,
  );
  check("no second shift was created", (await countSessions(alice.id)) === 1);
  check("the start time did not move", hidden?.startedAt.getTime() === shiftStartedAt);

  /* ------------------------------------------------------------------------ */
  section("4. Tracking keeps landing on the same shift while the tab is hidden");
  /* ------------------------------------------------------------------------ */

  const activity = await postJson("/api/monitor/activity", aliceDevice.accessToken, interval());
  const activityRow = activity.body.interval as Record<string, unknown> | undefined;
  check("an activity interval is accepted", activity.status === 201, `status ${activity.status}`);
  check("it belongs to the same shift", activityRow?.workSessionId === shiftId);

  const usage = await postJson("/api/monitor/app-usage", aliceDevice.accessToken, segment());
  const usageRow = usage.body.usage as Record<string, unknown> | undefined;
  check("an app-usage segment is accepted", usage.status === 201, `status ${usage.status}`);
  check(
    "it belongs to the same shift",
    usageRow?.workSessionId === shiftId,
    JSON.stringify(usageRow),
  );

  const shot = await uploadScreenshot(aliceDevice.accessToken);
  check("a screenshot is accepted", shot.status === 201, `status ${shot.status}`);
  const shotRow = await prisma.screenshot.findFirst({
    where: { userId: alice.id },
    orderBy: { createdAt: "desc" },
    select: { workSessionId: true },
  });
  check("it belongs to the same shift", shotRow?.workSessionId === shiftId);

  /* ------------------------------------------------------------------------ */
  section("5. The portal comes back to the front");
  /* ------------------------------------------------------------------------ */

  const returned = await portalBeat(aliceCookie);
  const clock = returned.body.clock as Record<string, unknown> | undefined;

  check("the beat answers", returned.status === 200);
  check(
    "the timer is not reset — the same startedAt comes back",
    typeof clock?.startedAt === "string" &&
      new Date(clock.startedAt as string).getTime() === shiftStartedAt,
    String(clock?.startedAt),
  );

  const reunited = await openSessionOf(alice.id);
  check("the existing shift was reused", reunited?.id === shiftId);
  check("no second shift exists", (await countSessions(alice.id)) === 1);
  check(
    "the portal heartbeat is fresh again",
    (reunited?.lastSeenAt.getTime() ?? 0) > Date.now() - 60_000,
  );

  /* ------------------------------------------------------------------------ */
  section("6. Only an authorized Monitor can keep a shift alive");
  /* ------------------------------------------------------------------------ */

  /*
   * Everything below is measured against a shift whose signals have both been
   * aged to the edge of the window: any write at all is visible, and none of
   * these callers is entitled to make one.
   */
  const parked = new Date(Date.now() - MONITOR_TOUCH_AFTER_MS - 5000);
  const reset = () =>
    prisma.workSession.update({
      where: { id: shiftId },
      data: { lastSeenAt: minutesAgo(4), lastMonitorSeenAt: parked },
    });

  const unchanged = async (label: string) => {
    const row = await sessionById(shiftId);
    check(label, row?.lastMonitorSeenAt?.getTime() === parked.getTime(), String(row?.lastMonitorSeenAt));
  };

  await reset();
  const noToken = await monitorPoll(null);
  check("an unauthenticated request is refused", noToken.status === 401);
  await unchanged("and keeps nothing alive");

  await reset();
  const badToken = await monitorPoll(randomBytes(32).toString("base64url"));
  check("an invalid bearer token is refused", badToken.status === 401);
  await unchanged("and keeps nothing alive");

  await reset();
  const revoked = await monitorPoll(aliceRevoked.accessToken);
  check("a revoked device is refused", revoked.status === 401);
  await unchanged("and cannot keep its own agent's shift alive");

  await reset();
  const otherAgent = await monitorPoll(bobDevice.accessToken);
  check("another agent's device authenticates for itself", otherAgent.status === 200);
  await unchanged("but cannot keep this agent's shift alive");
  check("and opened no shift for its own owner", (await countSessions(bob.id)) === 0);

  await reset();
  const adminPoll = await monitorPoll(adminDevice.accessToken);
  check("an administrator's device is refused by the Monitor API", adminPoll.status === 401);
  await unchanged("so an admin is never counted as a monitored agent");

  await prisma.user.update({ where: { id: alice.id }, data: { isActive: false } });
  await reset();
  const disabled = await monitorPoll(aliceDevice.accessToken);
  check("a disabled account's device is refused", disabled.status === 401);
  await unchanged("and keeps nothing alive");
  await prisma.user.update({ where: { id: alice.id }, data: { isActive: true } });
  // Disabling revoked every device for the account, which is the behaviour
  // being relied on above. A fresh one is needed for what follows.
  const aliceDevice2 = await connectDevice(alice.id);

  /* ------------------------------------------------------------------------ */
  section("7. A Monitor cannot revive a shift that has already gone stale");
  /* ------------------------------------------------------------------------ */

  // Held rather than recomputed later: the shift must close at *this* instant,
  // and a few seconds of test runtime must not be mistaken for a wrong answer.
  const monitorDiedAt = staleBy(1.5);
  const browserDiedAt = staleBy(3);
  await prisma.workSession.update({
    where: { id: shiftId },
    data: { lastSeenAt: browserDiedAt, lastMonitorSeenAt: monitorDiedAt },
  });

  const stalePoll = await monitorPoll(aliceDevice2.accessToken);
  const staleSession = stalePoll.body.workSession as Record<string, unknown> | undefined;

  check("the poll still authenticates", stalePoll.status === 200);
  check("but the shift is reported inactive", staleSession?.active === false);
  check("and carries no shift id", staleSession?.id === null);

  const notRevived = await sessionById(shiftId);
  check(
    "the monitor sighting was NOT moved forward",
    (notRevived?.lastMonitorSeenAt?.getTime() ?? 0) < Date.now() - STALE_MS,
    String(notRevived?.lastMonitorSeenAt),
  );

  const staleActivity = await postJson("/api/monitor/activity", aliceDevice2.accessToken, interval());
  check(
    "tracking is refused once the shift is stale",
    staleActivity.status === 409,
    `status ${staleActivity.status}`,
  );

  /* ------------------------------------------------------------------------ */
  section("8. Both signals quiet — the shift ends normally");
  /* ------------------------------------------------------------------------ */

  const afterStale = await portalBeat(aliceCookie);
  const newClock = afterStale.body.clock as Record<string, unknown> | undefined;

  const closed = await sessionById(shiftId);
  check("the stale shift was closed", closed?.endedAt !== null);
  check("as a timeout", closed?.endedReason === "timeout");
  check(
    "closed at the LATER of the two signals, not the browser's",
    closed?.endedAt?.getTime() === monitorDiedAt.getTime(),
    `got ${String(closed?.endedAt)}, wanted ${monitorDiedAt.toISOString()} ` +
      `(the browser's ${browserDiedAt.toISOString()} would be ` +
      `${Math.round((monitorDiedAt.getTime() - browserDiedAt.getTime()) / 60000)} minutes short)`,
  );

  const fresh = await openSessionOf(alice.id);
  check("a new shift was opened by the returning browser", fresh !== null && fresh.id !== shiftId);
  check("there are now two rows for this agent", (await countSessions(alice.id)) === 2);
  check(
    "and the clock reports the new one",
    typeof newClock?.startedAt === "string" &&
      new Date(newClock.startedAt as string).getTime() !== shiftStartedAt,
  );

  /* ------------------------------------------------------------------------ */
  section("9. Explicit ends still end the shift, whatever the Monitor is doing");
  /* ------------------------------------------------------------------------ */

  const secondShiftId = fresh!.id;

  // A poll first, so the Monitor is demonstrably live at the moment of logout.
  await prisma.workSession.update({
    where: { id: secondShiftId },
    data: { lastMonitorSeenAt: new Date(Date.now() - MONITOR_TOUCH_AFTER_MS - 5000) },
  });
  await monitorPoll(aliceDevice2.accessToken);
  const beforeLogout = await sessionById(secondShiftId);
  check(
    "the Monitor is live on this shift",
    (beforeLogout?.lastMonitorSeenAt?.getTime() ?? 0) > Date.now() - MONITOR_TOUCH_AFTER_MS,
  );

  check("logout answers", (await logout(aliceCookie)) === 200);

  const afterLogout = await sessionById(secondShiftId);
  check("logout ended the shift anyway", afterLogout?.endedAt !== null);
  check("as a logout", afterLogout?.endedReason === "logout");

  const pollAfterLogout = await monitorPoll(aliceDevice2.accessToken);
  const sessionAfterLogout = pollAfterLogout.body.workSession as Record<string, unknown> | undefined;
  check("the Monitor is told it is off the clock", sessionAfterLogout?.active === false);
  check(
    "and cannot reopen the closed shift",
    (await sessionById(secondShiftId))?.endedAt !== null,
  );
  check("nor open a new one", (await countSessions(alice.id)) === 2);

  const trackingAfterLogout = await postJson(
    "/api/monitor/app-usage",
    aliceDevice2.accessToken,
    segment(),
  );
  check(
    "tracking stops when the shift ends",
    trackingAfterLogout.status === 409,
    `status ${trackingAfterLogout.status}`,
  );

  /* ------------------------------------------------------------------------ */
  section("10. Reporting is consistent with the new rule");
  /* ------------------------------------------------------------------------ */

  /*
   * A shift whose tab has been hidden for an hour but whose Monitor is current
   * must be clamped to *now* by `OPEN_SESSION_END_SQL`, not to an hour ago —
   * otherwise the admin dashboard would quietly report an hour less than the
   * timer on the agent's own screen.
   */
  const bobCookie = await signIn(bob.id);
  await portalBeat(bobCookie);
  const bobShift = await openSessionOf(bob.id);
  check("the second agent has a shift", bobShift !== null);

  await prisma.workSession.update({
    where: { id: bobShift!.id },
    data: {
      startedAt: minutesAgo(90),
      lastSeenAt: minutesAgo(60),
      lastMonitorSeenAt: new Date(),
    },
  });

  const report = await get("/api/reports/time", adminCookie);
  const employees = (report.body.employees ?? []) as Array<Record<string, unknown>>;
  const bobRow = employees.find((row) => row.userId === bob.id);

  check("the admin time report answers", report.status === 200, `status ${report.status}`);
  check("the monitored agent is listed as online", bobRow?.online === true);

  /*
   * The report's window is *today*, and it clamps a shift at local midnight. A
   * run in the small hours would therefore see a shift that began yesterday and
   * measure something other than the ninety minutes staged above — the clamp is
   * correct, the assertion just stops being about liveness. Skipped rather than
   * loosened, so a failure here always means something real.
   */
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (Date.now() - midnight.getTime() < 2 * 60 * 60 * 1000) {
    console.log("  SKIP  tracked time spans local midnight — run again after 02:00");
  } else {
    check(
      "and their tracked time counts the hidden hour, not just the beating half",
      typeof bobRow?.todaySeconds === "number" && (bobRow.todaySeconds as number) > 80 * 60,
      `got ${String(bobRow?.todaySeconds)} — a browser-only clamp would give about ` +
        `${90 * 60 - (60 * 60 - STALE_MS / 1000)}`,
    );
  }

  /* ------------------------------------------------------------------------ */
  section("11. Existing behaviour is unchanged");
  /* ------------------------------------------------------------------------ */

  /*
   * The reported problem, as an assertion: an agent with no Monitor switches to
   * another tab or minimises Chrome, so the portal stops beating, and ten
   * minutes later they are still on the clock. Under the old five-minute window
   * this shift was closed underneath them — twice over — with nothing else
   * holding it open.
   *
   * Ten minutes is chosen because it is past the *old* window and inside the
   * new one, so this check fails if the window is ever narrowed back.
   */
  check(
    "a ten-minute-quiet tab with no Monitor is STILL on the clock",
    await (async () => {
      await prisma.workSession.update({
        where: { id: bobShift!.id },
        data: { lastSeenAt: minutesAgo(10), lastMonitorSeenAt: null },
      });
      const stillOn = await monitorPoll(bobDevice.accessToken);
      const body = stillOn.body.workSession as Record<string, unknown> | undefined;
      return body?.active === true;
    })(),
  );

  check(
    "a shift with no Monitor still goes stale on the browser heartbeat alone",
    await (async () => {
      // `last_monitor_seen_at` null — every shift worked before this shipped.
      await prisma.workSession.update({
        where: { id: bobShift!.id },
        data: { lastSeenAt: staleBy(2), lastMonitorSeenAt: null },
      });
      const bobPoll = await monitorPoll(bobDevice.accessToken);
      const body = bobPoll.body.workSession as Record<string, unknown> | undefined;
      return body?.active === false;
    })(),
  );

  check(
    "the admin time dashboard still answers",
    (await get("/api/reports/time", adminCookie)).status === 200,
  );
  check(
    "the employee time detail still answers",
    (await get(`/api/reports/time/${bob.id}`, adminCookie)).status === 200,
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
    "app-usage reporting still answers",
    (await get("/api/reports/app-usage", adminCookie)).status === 200,
  );
  check(
    "the team report still answers",
    (await get("/api/reports/team", adminCookie)).status === 200,
  );
  check(
    "the leads API still answers",
    (await get("/api/leads?page=1", adminCookie)).status === 200,
  );
  check(
    "the screenshot viewer still answers",
    (await get("/api/screenshots", adminCookie)).status === 200,
  );
  check(
    "an agent can still read their own time tracking",
    (await get("/api/time-tracking/me", bobCookie)).status === 200,
  );
  check(
    "an unauthenticated portal heartbeat is still refused",
    (
      await fetch(`${BASE_URL}/api/work-session/heartbeat`, {
        method: "POST",
        redirect: "manual",
      })
    ).status === 401,
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
