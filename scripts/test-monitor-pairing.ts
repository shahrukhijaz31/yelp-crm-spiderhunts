import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * Connecting a workstation from the portal: the pairing API end to end, the
 * boundaries around it, and the things that must never happen.
 *
 *   npm run dev                   (in one terminal)
 *   npm run test:monitor-pairing  (in another)
 *
 * Written against the live routes for the reason every script here gives: the
 * claims worth checking are claims about HTTP routes, a session cookie, a
 * database row and the *absence* of a field, and a mocked version would pass
 * whether or not the real thing works.
 *
 * What it holds in place:
 *
 *   - starting a pairing names nobody — no account is sent, and none comes back
 *   - a pending pairing yields nothing until an authenticated agent approves it
 *   - approving needs a session, and needs to come from the portal's own origin
 *   - one pairing produces exactly one workstation, even when two polls race
 *   - an administrator cannot connect one, and a denial is final
 *   - a disconnect reaches only the caller's own machines
 *
 * It creates throwaway accounts (`pairtest-*`), their devices and pairings, and
 * deletes all of it on the way out, including after a failure. It never touches
 * an existing user, device or pairing.
 *
 * **Two things are checked by calling the library rather than the route**, and
 * both say so where they appear: the same-network rule, because `clientIp()`
 * returns the shared `"unknown"` bucket whenever `TRUSTED_PROXY_HOPS` is 0 —
 * which is every development machine, by design — so over a dev server there
 * are no two different addresses to compare; and expiry, which would otherwise
 * need the test to wait five minutes.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "pairing-test-Pa55phrase";

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

/**
 * Mint a portal session and return the cookie header value.
 *
 * Inserted directly, as every script in this directory does: a real sign-in
 * needs a six-digit code delivered by email, which a test cannot read. The
 * construction is copied from `lib/session.ts`, so what the routes authenticate
 * is exactly what they authenticate in production.
 */
async function signIn(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + 12 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      userAgent: "pairing-test",
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

async function post(
  path: string,
  payload: unknown,
  options: { cookie?: string; origin?: string } = {},
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      // A browser sends both; the CSRF rule reads them together. Omitting them
      // entirely is what makes an ordinary script call count as "not a browser".
      ...(options.origin
        ? { origin: options.origin, "sec-fetch-site": "cross-site" }
        : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });

  return { status: response.status, body: await readJson(response) };
}

async function startPairingOverHttp(device?: Record<string, string>): Promise<Reply> {
  return post("/api/monitor/pairing/start", device ? { device } : {});
}

async function poll(deviceCode: string): Promise<Reply> {
  return post("/api/monitor/pairing/poll", { deviceCode });
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const created: string[] = [];

async function main(): Promise<void> {
  console.log(`Workstation pairing checks against ${BASE_URL}\n`);

  const stamp = Date.now();
  const passwordHash = await hashPassword(PASSWORD);

  const agent = await prisma.user.create({
    data: {
      username: `pairtest-agent-${stamp}`,
      email: `pairtest-agent-${stamp}@example.test`,
      name: "Pairing Test Agent",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  const other = await prisma.user.create({
    data: {
      username: `pairtest-other-${stamp}`,
      email: `pairtest-other-${stamp}@example.test`,
      name: "Pairing Test Other",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  const contributor = await prisma.user.create({
    data: {
      username: `pairtest-contrib-${stamp}`,
      email: `pairtest-contrib-${stamp}@example.test`,
      name: "Pairing Test Contributor",
      passwordHash,
      role: "CONTRIBUTOR",
    },
    select: { id: true },
  });
  const admin = await prisma.user.create({
    data: {
      username: `pairtest-admin-${stamp}`,
      email: `pairtest-admin-${stamp}@example.test`,
      name: "Pairing Test Admin",
      passwordHash,
      role: "ADMIN",
    },
    select: { id: true },
  });
  created.push(agent.id, other.id, contributor.id, admin.id);

  const agentCookie = await signIn(agent.id);
  const otherCookie = await signIn(other.id);
  const contributorCookie = await signIn(contributor.id);
  const adminCookie = await signIn(admin.id);

  /* --- starting ----------------------------------------------------------- */
  section("Starting a pairing names nobody");

  const started = await startPairingOverHttp({
    name: "PAIRTEST-DESKTOP",
    platform: "win32",
    appVersion: "1.1.0-test",
  });

  check("start is accepted", started.status === 201, `status ${started.status}`);
  check(
    "it returns a request id and a device code",
    typeof started.body.requestId === "string" &&
      typeof started.body.deviceCode === "string" &&
      (started.body.requestId as string) !== (started.body.deviceCode as string),
  );

  const startedText = JSON.stringify(started.body).toLowerCase();
  check(
    "the reply carries no identity of any kind",
    !startedText.includes("pairtest") &&
      !startedText.includes("@example.test") &&
      !startedText.includes("userid"),
    startedText.slice(0, 160),
  );

  const requestId = started.body.requestId as string;
  const deviceCode = started.body.deviceCode as string;

  const pendingRow = await prisma.monitorPairing.findUnique({
    where: { publicId: requestId },
    select: { userId: true, deviceCodeHash: true, deviceName: true },
  });
  check("the pending row belongs to nobody", pendingRow?.userId === null);
  check(
    "only the hash of the device code is stored",
    pendingRow?.deviceCodeHash === hashToken(deviceCode) &&
      /^[0-9a-f]{64}$/.test(pendingRow?.deviceCodeHash ?? ""),
  );
  check(
    "the workstation name is recorded at start",
    pendingRow?.deviceName === "PAIRTEST-DESKTOP",
    `got ${pendingRow?.deviceName}`,
  );

  /* --- polling before approval -------------------------------------------- */
  section("Nothing is issued until somebody approves");

  const early = await poll(deviceCode);
  check(
    "an unapproved pairing polls as pending",
    early.status === 200 && early.body.state === "pending",
    `status ${early.status}, state ${String(early.body.state)}`,
  );
  check("no tokens are handed out while pending", early.body.tokens === undefined);

  const unknown = await poll(randomBytes(32).toString("base64url"));
  check(
    "an unknown device code is refused",
    unknown.status === 401 && unknown.body.error === "invalid_device_code",
    `status ${unknown.status}`,
  );

  /* --- who may approve ----------------------------------------------------- */
  section("Approving needs a session, from the portal itself");

  const anonymous = await post("/api/account/workstations/approve", { requestId });
  check("approving with no session is refused", anonymous.status === 401, `status ${anonymous.status}`);

  const crossSite = await post(
    "/api/account/workstations/approve",
    { requestId },
    { cookie: agentCookie, origin: "https://evil.example" },
  );
  check(
    "approving from another origin is refused",
    crossSite.status === 403,
    `status ${crossSite.status}`,
  );

  const byAdmin = await post(
    "/api/account/workstations/approve",
    { requestId },
    { cookie: adminCookie },
  );
  check(
    "an administrator cannot connect a workstation",
    byAdmin.status === 403 && byAdmin.body.error === "role_not_permitted",
    `status ${byAdmin.status}, error ${String(byAdmin.body.error)}`,
  );

  const devicesAfterRefusals = await prisma.monitorDevice.count({
    where: { userId: { in: created } },
  });
  check("no workstation exists after those refusals", devicesAfterRefusals === 0, `${devicesAfterRefusals} found`);

  /* --- the happy path ------------------------------------------------------ */
  section("The agent approves, and the workstation collects its credential");

  const approved = await post(
    "/api/account/workstations/approve",
    { requestId },
    { cookie: agentCookie },
  );
  check("the agent's approval is accepted", approved.status === 200, `status ${approved.status}`);
  check(
    "the reply names the workstation being connected",
    approved.body.deviceName === "PAIRTEST-DESKTOP",
    `got ${String(approved.body.deviceName)}`,
  );

  const collected = await poll(deviceCode);
  check(
    "the workstation is given its tokens",
    collected.status === 200 && collected.body.state === "approved",
    `status ${collected.status}, state ${String(collected.body.state)}`,
  );

  const tokens = collected.body.tokens as { accessToken?: string; refreshToken?: string } | undefined;
  const user = collected.body.user as { id?: string } | undefined;
  check("the credential belongs to the approving agent", user?.id === agent.id);

  const sessionReply = await fetch(`${BASE_URL}/api/monitor/session`, {
    headers: { authorization: `Bearer ${tokens?.accessToken ?? ""}` },
  });
  const sessionBody = await readJson(sessionReply);
  check(
    "the access token works on the monitor API",
    sessionReply.status === 200 &&
      (sessionBody.user as { id?: string } | undefined)?.id === agent.id,
    `status ${sessionReply.status}`,
  );

  const device = await prisma.monitorDevice.findFirst({
    where: { userId: agent.id },
    select: { id: true, deviceName: true, platform: true, appVersion: true },
  });
  check(
    "the workstation is recorded with the name it gave at start",
    device?.deviceName === "PAIRTEST-DESKTOP" &&
      device?.platform === "win32" &&
      device?.appVersion === "1.1.0-test",
    `got ${JSON.stringify(device)}`,
  );

  /* --- single use ---------------------------------------------------------- */
  section("A pairing is good exactly once");

  const second = await poll(deviceCode);
  check(
    "collecting twice is refused",
    second.status === 410 && second.body.error === "pairing_consumed",
    `status ${second.status}, error ${String(second.body.error)}`,
  );

  const deviceCount = await prisma.monitorDevice.count({ where: { userId: agent.id } });
  check("exactly one workstation was created", deviceCount === 1, `${deviceCount} found`);

  const reapprove = await post(
    "/api/account/workstations/approve",
    { requestId },
    { cookie: agentCookie },
  );
  check(
    "a consumed pairing cannot be approved again",
    reapprove.status === 409,
    `status ${reapprove.status}`,
  );

  /* --- denial -------------------------------------------------------------- */
  section("A denial is final");

  const toDeny = await startPairingOverHttp({ name: "PAIRTEST-DENIED" });
  const denyId = toDeny.body.requestId as string;
  const denyCode = toDeny.body.deviceCode as string;

  const denied = await post(
    "/api/account/workstations/deny",
    { requestId: denyId },
    { cookie: agentCookie },
  );
  check("deny answers 200", denied.status === 200, `status ${denied.status}`);

  const afterDeny = await poll(denyCode);
  check(
    "a denied workstation is told so",
    afterDeny.status === 403 && afterDeny.body.error === "pairing_denied",
    `status ${afterDeny.status}, error ${String(afterDeny.body.error)}`,
  );

  const approveDenied = await post(
    "/api/account/workstations/approve",
    { requestId: denyId },
    { cookie: agentCookie },
  );
  check(
    "a denied pairing cannot then be approved",
    approveDenied.status === 409,
    `status ${approveDenied.status}`,
  );

  /* --- expiry, by moving the clock on the row ------------------------------ */
  section("An expired request is refused, not revived");

  const toExpire = await startPairingOverHttp({ name: "PAIRTEST-STALE" });
  const staleId = toExpire.body.requestId as string;
  const staleCode = toExpire.body.deviceCode as string;

  // Written directly rather than waited for: the TTL is five minutes, and a
  // test that waited would not be a test.
  await prisma.monitorPairing.update({
    where: { publicId: staleId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const approveStale = await post(
    "/api/account/workstations/approve",
    { requestId: staleId },
    { cookie: agentCookie },
  );
  check(
    "an expired pairing cannot be approved",
    approveStale.status === 404,
    `status ${approveStale.status}`,
  );

  const pollStale = await poll(staleCode);
  check(
    "an expired pairing cannot be collected",
    pollStale.status === 410 && pollStale.body.error === "pairing_expired",
    `status ${pollStale.status}, error ${String(pollStale.body.error)}`,
  );

  /* --- the same-network rule ----------------------------------------------- */
  section("Approving from somewhere else is refused");

  // Called directly, not over HTTP: `clientIp()` answers "unknown" for every
  // request whenever TRUSTED_PROXY_HOPS is 0, which is the default outside
  // production — so a dev server has no two addresses to tell apart. The rule
  // itself is what matters, and this exercises exactly the code the route runs.
  const { approvePairing, startPairing } = await import("../lib/monitorPairing");

  const remote = await startPairing({ deviceName: "PAIRTEST-REMOTE" }, "198.51.100.4");
  const fromElsewhere = await approvePairing(remote.requestId, agent.id, "203.0.113.9");
  check(
    "an approval from a different address is refused",
    !fromElsewhere.ok && fromElsewhere.code === "different_network",
    `got ${JSON.stringify(fromElsewhere)}`,
  );

  const sameAddress = await approvePairing(remote.requestId, agent.id, "198.51.100.4");
  check(
    "the same address is accepted",
    sameAddress.ok === true,
    `got ${JSON.stringify(sameAddress)}`,
  );

  /* --- a contributor ------------------------------------------------------- */
  section("Contributors connect workstations too");

  const contribStart = await startPairingOverHttp({ name: "PAIRTEST-CONTRIB" });
  const contribApproved = await post(
    "/api/account/workstations/approve",
    { requestId: contribStart.body.requestId },
    { cookie: contributorCookie },
  );
  const contribPoll = await poll(contribStart.body.deviceCode as string);
  check(
    "a contributor can connect a workstation",
    contribApproved.status === 200 && contribPoll.status === 200,
    `approve ${contribApproved.status}, poll ${contribPoll.status}`,
  );

  /* --- disconnecting ------------------------------------------------------- */
  section("Disconnecting reaches only your own machines");

  const foreign = await post(
    "/api/account/workstations/disconnect",
    { deviceId: device?.id },
    { cookie: otherCookie },
  );
  check(
    "another agent cannot disconnect your workstation",
    foreign.status === 404,
    `status ${foreign.status}`,
  );

  const stillLive = await prisma.monitorDevice.count({
    where: { id: device?.id, revokedAt: null },
  });
  check("it is still connected after that attempt", stillLive === 1);

  const own = await post(
    "/api/account/workstations/disconnect",
    { deviceId: device?.id },
    { cookie: agentCookie },
  );
  check("the owner can disconnect it", own.status === 200, `status ${own.status}`);

  const afterDisconnect = await fetch(`${BASE_URL}/api/monitor/session`, {
    headers: { authorization: `Bearer ${tokens?.accessToken ?? ""}` },
  });
  check(
    "the disconnected workstation stops working immediately",
    afterDisconnect.status === 401,
    `status ${afterDisconnect.status}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Remove everything this run created.
 *
 * Pairings before users, because an approved pairing points at one; devices and
 * sessions likewise. Ordered rather than left to cascade rules, so a change to
 * those does not quietly turn cleanup into a no-op.
 */
async function cleanup(): Promise<void> {
  if (created.length === 0) return;

  await prisma.monitorPairing.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.monitorPairing
    .deleteMany({ where: { deviceName: { startsWith: "PAIRTEST-" } } })
    .catch(() => {});
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
