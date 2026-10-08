import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * The Monitor's refresh window: that it slides, that it is bounded, and that
 * rotation still does everything it did before.
 *
 *   npm run dev                   (in one terminal)
 *   npm run test:monitor-refresh  (in another)
 *
 * Written against the live route rather than the function, for the reason every
 * script in this directory gives: what matters is what
 * `POST /api/monitor/auth/refresh` returns to a workstation, and a unit test of
 * `refreshDeviceTokens` would pass whether or not the route reaches it.
 *
 * The claims under test are the ones a reader of `lib/monitorAuth.ts` is now
 * being asked to believe:
 *
 *   - a refresh extends the connection, where it used to carry the old ceiling
 *     forward untouched
 *   - the extension stops at 180 days from `created_at`, so a device that
 *     refreshes for ever does not live for ever
 *   - a connection already past its ceiling is refused rather than revived
 *   - rotation is unchanged: the old refresh token dies, and a second use of it
 *     is refused
 *
 * Ages are set by writing `created_at` and `refresh_expires_at` directly. A test
 * that waited six months would not be a test. Device rows are inserted rather
 * than signed in for, because a real sign-in needs a six-digit code delivered by
 * email; the token construction is copied from `lib/monitorAuth.ts`, so what the
 * route authenticates is exactly what it authenticates in production.
 *
 * It creates one throwaway agent (`refreshtest-*`) and deletes it on the way
 * out, including after a failure. It never touches an existing user or device.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "refresh-test-Pa55phrase";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Both from `lib/monitorAuth.ts`. If they change there, they change here. */
const IDLE_TTL_MS = 30 * DAY_MS;
const ABSOLUTE_TTL_MS = 180 * DAY_MS;

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

interface Connected {
  deviceId: string;
  refreshToken: string;
}

/**
 * A connected workstation, as `issueDeviceTokens` would have left it.
 *
 * `connectedDaysAgo` backdates `created_at` so the absolute ceiling can be
 * reached without waiting for it; `expiresInDays` sets the current window,
 * which is what an already-expired device needs.
 */
async function connectDevice(
  userId: string,
  options: { connectedDaysAgo?: number; expiresInDays?: number } = {},
): Promise<Connected> {
  const { connectedDaysAgo = 0, expiresInDays = 30 } = options;
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const now = Date.now();

  const device = await prisma.monitorDevice.create({
    data: {
      userId,
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: new Date(now + 15 * 60 * 1000),
      refreshTokenHash: hashToken(refreshToken),
      refreshExpiresAt: new Date(now + expiresInDays * DAY_MS),
      createdAt: new Date(now - connectedDaysAgo * DAY_MS),
      deviceName: "refresh-test",
      platform: "win32",
      appVersion: "test",
    },
    select: { id: true },
  });

  return { deviceId: device.id, refreshToken };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function refresh(refreshToken: string): Promise<Reply> {
  const response = await fetch(`${BASE_URL}/api/monitor/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  return { status: response.status, body };
}

/** The `refreshExpiresAt` out of a successful reply, in epoch milliseconds. */
function refreshExpiryOf(reply: Reply): number {
  const tokens = reply.body.tokens as { refreshExpiresAt?: string } | undefined;
  return new Date(tokens?.refreshExpiresAt ?? 0).getTime();
}

function refreshTokenOf(reply: Reply): string {
  const tokens = reply.body.tokens as { refreshToken?: string } | undefined;
  return tokens?.refreshToken ?? "";
}

/** Within a minute of the expected instant — the clock moves during a request. */
function near(actual: number, expected: number, toleranceMs = 60 * 1000): boolean {
  return Math.abs(actual - expected) <= toleranceMs;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const created: string[] = [];

async function main(): Promise<void> {
  console.log(`Monitor refresh window checks against ${BASE_URL}\n`);

  const stamp = Date.now();
  const agent = await prisma.user.create({
    data: {
      username: `refreshtest-agent-${stamp}`,
      email: `refreshtest-agent-${stamp}@example.test`,
      name: "Refresh Test Agent",
      passwordHash: await hashPassword(PASSWORD),
      role: "AGENT",
    },
    select: { id: true },
  });
  created.push(agent.id);

  /* --- the window slides ------------------------------------------------- */
  section("A refresh extends the connection");

  // Connected a fortnight ago with a fortnight left: a workstation in ordinary
  // daily use, which under the old rule would have had to sign in again in two
  // weeks however often it called in.
  const daily = await connectDevice(agent.id, { connectedDaysAgo: 14, expiresInDays: 16 });
  const slid = await refresh(daily.refreshToken);

  check("a refresh is accepted", slid.status === 200, `status ${slid.status}`);
  check(
    "the connection is extended to a full idle window from now",
    near(refreshExpiryOf(slid), Date.now() + IDLE_TTL_MS),
    `got ${new Date(refreshExpiryOf(slid)).toISOString()}`,
  );

  const storedAfterSlide = await prisma.monitorDevice.findUnique({
    where: { id: daily.deviceId },
    select: { refreshExpiresAt: true },
  });
  check(
    "the extension is stored, not merely reported",
    near(storedAfterSlide?.refreshExpiresAt.getTime() ?? 0, refreshExpiryOf(slid), 1000),
    `row says ${storedAfterSlide?.refreshExpiresAt.toISOString()}`,
  );

  /* --- rotation still rotates -------------------------------------------- */
  section("Rotation is unchanged");

  const rotatedToken = refreshTokenOf(slid);
  check("a new refresh token is issued", rotatedToken.length > 0 && rotatedToken !== daily.refreshToken);

  const replayed = await refresh(daily.refreshToken);
  check(
    "the spent refresh token is refused",
    replayed.status === 401 && replayed.body.error === "invalid_refresh",
    `status ${replayed.status}, error ${String(replayed.body.error)}`,
  );

  const afterReplay = await refresh(rotatedToken);
  check("the new refresh token still works", afterReplay.status === 200, `status ${afterReplay.status}`);

  /* --- the ceiling holds -------------------------------------------------- */
  section("The absolute ceiling bounds the sliding window");

  // Connected 179 days ago: the sliding window would take this to 30 days out,
  // the ceiling allows one more day, and the ceiling must win.
  const old = await connectDevice(agent.id, { connectedDaysAgo: 179, expiresInDays: 5 });
  const clamped = await refresh(old.refreshToken);
  const createdAtOf = await prisma.monitorDevice.findUnique({
    where: { id: old.deviceId },
    select: { createdAt: true },
  });
  const ceiling = (createdAtOf?.createdAt.getTime() ?? 0) + ABSOLUTE_TTL_MS;

  check("a refresh near the ceiling is accepted", clamped.status === 200, `status ${clamped.status}`);
  check(
    "the expiry is clamped to 180 days from the day it connected",
    near(refreshExpiryOf(clamped), ceiling),
    `got ${new Date(refreshExpiryOf(clamped)).toISOString()}, ceiling ${new Date(ceiling).toISOString()}`,
  );
  check(
    "the clamped expiry is sooner than a full idle window",
    refreshExpiryOf(clamped) < Date.now() + IDLE_TTL_MS,
  );

  /* --- past the ceiling, and past the window ------------------------------ */
  section("An expired connection is refused, not revived");

  const lapsed = await connectDevice(agent.id, { connectedDaysAgo: 200, expiresInDays: -1 });
  const refused = await refresh(lapsed.refreshToken);
  check(
    "a device past its expiry cannot refresh",
    refused.status === 401 && refused.body.error === "invalid_refresh",
    `status ${refused.status}, error ${String(refused.body.error)}`,
  );

  const lapsedRow = await prisma.monitorDevice.findUnique({
    where: { id: lapsed.deviceId },
    select: { refreshExpiresAt: true },
  });
  check(
    "a refused refresh does not extend anything",
    (lapsedRow?.refreshExpiresAt.getTime() ?? 0) < Date.now(),
    `row says ${lapsedRow?.refreshExpiresAt.toISOString()}`,
  );

  /* --- a disabled account ------------------------------------------------- */
  section("Eligibility is still checked on every refresh");

  const disabledDevice = await connectDevice(agent.id);
  await prisma.user.update({ where: { id: agent.id }, data: { isActive: false } });

  const disabled = await refresh(disabledDevice.refreshToken);
  check(
    "a disabled account cannot refresh",
    disabled.status === 401 && disabled.body.error === "account_disabled",
    `status ${disabled.status}, error ${String(disabled.body.error)}`,
  );

  const liveAfterDisable = await prisma.monitorDevice.count({
    where: { userId: agent.id, revokedAt: null },
  });
  check(
    "every workstation for that account is revoked",
    liveAfterDisable === 0,
    `${liveAfterDisable} still live`,
  );

  await prisma.user.update({ where: { id: agent.id }, data: { isActive: true } });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/** Remove everything this run created: devices first, then the account. */
async function cleanup(): Promise<void> {
  if (created.length === 0) return;

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
