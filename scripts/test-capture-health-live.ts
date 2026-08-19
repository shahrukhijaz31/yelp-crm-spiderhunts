import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";

/**
 * End-to-end check of screenshot-health reporting and detection.
 *
 *   npm run dev                          (in one terminal)
 *   npm run test:capture-health-live     (in another)
 *
 * The thresholds themselves are checked as pure functions in
 * `test-capture-health.ts`, which needs neither a server nor a database. This
 * checks the three things a fixture cannot: that the route authenticates and
 * writes to the right row, that a workstation cannot write a health report
 * against somebody else's device, and — the point of the whole feature — that a
 * shift with a live Monitor and no screenshots is detected as unhealthy whatever
 * the client claims about itself.
 *
 * ---------------------------------------------------------------------------
 * How time passes in here
 * ---------------------------------------------------------------------------
 * The same trick `test-work-session-liveness.ts` uses: a test may not sleep for
 * two capture intervals, so rows are aged instead. `started_at` is pushed into
 * the past to mean "this shift has been open long enough that several captures
 * should have arrived", which is exactly the state a blocked capture directory
 * produces. Nothing under test is stubbed, and every decision is still made on
 * the server's own clock.
 */

loadEnv({ path: ".env", quiet: true });

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const created: string[] = [];
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

const hash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const token = () => randomBytes(32).toString("base64url");

/** A throwaway agent with an open shift and a connected device. */
async function makeAgent(suffix: string) {
  const access = token();
  const refresh = token();

  const user = await prisma.user.create({
    data: {
      name: `Capture Health ${suffix}`,
      username: `caphealth-${suffix}-${randomBytes(4).toString("hex")}`,
      email: `caphealth-${suffix}-${randomBytes(4).toString("hex")}@example.invalid`,
      passwordHash: "x".repeat(60),
      role: "AGENT",
      isActive: true,
    },
    select: { id: true },
  });
  created.push(user.id);

  const device = await prisma.monitorDevice.create({
    data: {
      userId: user.id,
      accessTokenHash: hash(access),
      accessExpiresAt: new Date(Date.now() + 15 * 60_000),
      refreshTokenHash: hash(refresh),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      deviceName: `probe-${suffix}`,
    },
    select: { id: true },
  });

  const session = await prisma.workSession.create({
    data: { userId: user.id, lastMonitorSeenAt: new Date() },
    select: { id: true },
  });

  return { userId: user.id, deviceId: device.id, sessionId: session.id, access };
}

function post(path: string, access: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  console.log("\nScreenshot health, end to end\n");

  const alice = await makeAgent("alice");
  const bob = await makeAgent("bob");

  /* --- the route ------------------------------------------------------- */
  console.log("The report route");
  {
    const unauth = await fetch(`${BASE}/api/monitor/capture-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ok" }),
    });
    check("refuses an unauthenticated report", unauth.status === 401, String(unauth.status));

    const bad = await post("/api/monitor/capture-health", alice.access, { status: "nonsense" });
    check("refuses an unknown status", bad.status === 400, String(bad.status));

    const good = await post("/api/monitor/capture-health", alice.access, { status: "write-failed" });
    check("accepts a known status", good.status === 204, String(good.status));

    const row = await prisma.monitorDevice.findUnique({
      where: { id: alice.deviceId },
      select: { captureHealth: true, captureHealthAt: true },
    });
    check("writes it to the authenticated device", row?.captureHealth === "write-failed", String(row?.captureHealth));
    check("stamps it with the server's clock", row?.captureHealthAt instanceof Date);
  }

  /* --- ownership ------------------------------------------------------- */
  console.log("\nOwnership");
  {
    // There is no device id in the body, so the only way to test this is to
    // confirm one agent's report never lands on another's row.
    await post("/api/monitor/capture-health", bob.access, { status: "ok" });

    const aliceRow = await prisma.monitorDevice.findUnique({
      where: { id: alice.deviceId },
      select: { captureHealth: true },
    });
    check(
      "another agent's report does not touch this device",
      aliceRow?.captureHealth === "write-failed",
      String(aliceRow?.captureHealth),
    );
  }

  /* --- detection ------------------------------------------------------- */
  console.log("\nDetection: a live Monitor, no screenshots");
  {
    const { openSessionCaptureHealth } = await import("../lib/captureHealth");
    const { capturePolicy } = await import("../lib/screenshotPolicy");
    const maxMinutes = capturePolicy().maxIntervalSeconds / 60;

    // Age the shift so several captures should have arrived, and keep the
    // Monitor's liveness fresh — the exact state a blocked capture directory
    // produces.
    await prisma.workSession.update({
      where: { id: alice.sessionId },
      data: {
        startedAt: new Date(Date.now() - 6 * maxMinutes * 60_000),
        lastMonitorSeenAt: new Date(),
      },
    });

    const verdicts = await openSessionCaptureHealth(new Date());
    const alicesVerdict = verdicts.get(alice.userId);

    check("a verdict is produced for the open shift", alicesVerdict !== undefined);
    check("it is unhealthy", alicesVerdict?.state === "unhealthy", alicesVerdict?.state);
    check("it carries the reported reason", alicesVerdict?.reason === "write-failed", String(alicesVerdict?.reason));
    check("write-failed is not treated as benign", alicesVerdict?.benign === false);

    // The property that matters most: a client that lies cannot clear it.
    await post("/api/monitor/capture-health", alice.access, { status: "ok" });
    const afterLie = (await openSessionCaptureHealth(new Date())).get(alice.userId);
    check("a client claiming ok stays unhealthy", afterLie?.state === "unhealthy", afterLie?.state);
    check("and is flagged as contradicted", afterLie?.contradicted === true);

    // And a real screenshot clears it, which is what stops this being noise.
    await prisma.screenshot.create({
      data: {
        userId: alice.userId,
        workSessionId: alice.sessionId,
        deviceId: alice.deviceId,
        capturedAt: new Date(),
        storageKey: `test/${randomBytes(8).toString("hex")}.jpg`,
        width: 1920,
        height: 1080,
        fileSize: 1024,
        format: "jpeg",
        displayId: "0",
      },
    });

    const afterShot = (await openSessionCaptureHealth(new Date())).get(alice.userId);
    check("an arriving screenshot clears it", afterShot?.state === "ok", afterShot?.state);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

async function cleanup() {
  if (created.length === 0) return;
  await prisma.screenshot.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.workSession.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.monitorDevice.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
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
