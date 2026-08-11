import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * End-to-end check of the screenshot upload rate limit and the retention sweep,
 * against a running server and a real database.
 *
 *   npm run dev              (in one terminal)
 *   npm run test:screenshots (in another)
 *
 * Written for the same reason `test-recordings.ts` was: this repository has no
 * test framework, and none of the claims worth checking here are unit-testable
 * in any useful sense. "A second upload inside the window is refused and stores
 * nothing" is a claim about an HTTP route, a conditional `UPDATE` and the
 * filesystem; a mocked version of it would pass whether or not the real thing
 * works. So this speaks HTTP to the real route and then looks in Postgres and on
 * disk to see what actually happened.
 *
 * It creates a throwaway agent (`shottest-*`), its work session and its monitor
 * device, and deletes all three — plus every screenshot and file it produced —
 * on the way out, including after a failure. It never touches an existing user,
 * device or screenshot.
 *
 * **The device row is inserted directly rather than signed in for.** A real
 * Monitor sign-in needs a six-digit code delivered by email, which a test cannot
 * read. The token construction is copied from `lib/monitorAuth.ts` (32 random
 * bytes, SHA-256 into the row) so what the route authenticates is exactly what
 * it authenticates in production.
 *
 * The Electron scheduler is not covered here — it runs on a workstation, and its
 * behaviour is observable in the Monitor's own log. What this covers is
 * everything the server owns: the rate limit, the policy the server hands the
 * client, and retention.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "screenshot-test-Pa55phrase";

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

/**
 * A JPEG as far as `sniffImage` is concerned, and as far as anything that only
 * reads headers is concerned: SOI, a comment segment carrying the padding that
 * takes it over the 1KB floor, a start-of-frame stating the dimensions, EOI.
 *
 * No entropy-coded scan, so it is not a viewable picture — the point is to
 * exercise the route's validation and the storage path with bytes whose true
 * dimensions are known, without shipping a binary fixture into the repository.
 */
function fakeJpeg(width: number, height: number, padding = 2048): Uint8Array<ArrayBuffer> {
  const comment = Buffer.alloc(2 + 2 + padding);
  comment.writeUInt8(0xff, 0);
  comment.writeUInt8(0xfe, 1); // COM
  comment.writeUInt16BE(2 + padding, 2);

  const sof = Buffer.alloc(2 + 2 + 6);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1); // SOF0
  sof.writeUInt16BE(8 + 3, 2); // length: header + one component
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(1, 9); // component count

  const joined = Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    comment,
    sof,
    Buffer.from([0x00, 0x01, 0x11, 0x00]), // the component spec SOF0 promised
    Buffer.from([0xff, 0xd9]), // EOI
  ]);

  // A copy over its own bytes: `Buffer` is typed as backed by `ArrayBufferLike`,
  // which `Blob` will not accept.
  return new Uint8Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.length));
}

async function upload(
  accessToken: string,
  bytes: Uint8Array<ArrayBuffer>,
  capturedAt = new Date().toISOString(),
): Promise<{ status: number; body: Record<string, unknown>; retryAfter: string | null }> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), "screenshot.jpg");
  form.append("capturedAt", capturedAt);
  form.append("displayId", "2528732444");

  const response = await fetch(`${BASE_URL}/api/monitor/screenshots`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
}

function storageRoot(): string {
  const configured = process.env.SCREENSHOTS_DIR?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".data/screenshots");
}

async function exists(storageKey: string): Promise<boolean> {
  try {
    await access(path.resolve(storageRoot(), storageKey));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const username = `shottest-${suffix}`;

  console.log(`\nScreenshot rate limit + retention — ${BASE_URL}\n`);

  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.invalid`,
      name: "Screenshot Test Agent",
      passwordHash: await hashPassword(PASSWORD),
      role: "AGENT",
      isActive: true,
    },
    select: { id: true },
  });

  // An open, beating shift. `getActiveWorkSession` refuses one whose heartbeat
  // has stopped, so `lastSeenAt` has to be now rather than merely `endedAt`
  // being null.
  await prisma.workSession.create({
    data: { userId: user.id, startedAt: new Date(), lastSeenAt: new Date() },
  });

  const accessToken = randomBytes(32).toString("base64url");
  const device = await prisma.monitorDevice.create({
    data: {
      userId: user.id,
      accessTokenHash: createHash("sha256").update(accessToken, "utf8").digest("hex"),
      accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      refreshTokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      deviceName: "test-workstation",
      platform: "win32",
      appVersion: "0.1.0",
    },
    select: { id: true },
  });

  try {
    // -----------------------------------------------------------------------
    console.log("The policy the server hands the client");
    // -----------------------------------------------------------------------
    const session = await fetch(`${BASE_URL}/api/monitor/session`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const sessionBody = (await session.json()) as {
      screenshotPolicy?: { minIntervalSeconds?: number; maxIntervalSeconds?: number };
    };
    const policy = sessionBody.screenshotPolicy;

    check("GET /api/monitor/session answers", session.status === 200, `status ${session.status}`);
    check(
      "it carries a screenshot policy",
      typeof policy?.minIntervalSeconds === "number" &&
        typeof policy?.maxIntervalSeconds === "number",
      JSON.stringify(policy),
    );
    check(
      "min is at least a minute and max is above min",
      (policy?.minIntervalSeconds ?? 0) >= 1 &&
        (policy?.maxIntervalSeconds ?? 0) > (policy?.minIntervalSeconds ?? 0),
      `${policy?.minIntervalSeconds}–${policy?.maxIntervalSeconds}`,
    );

    // -----------------------------------------------------------------------
    console.log("\nRate limit");
    // -----------------------------------------------------------------------
    const first = await upload(accessToken, fakeJpeg(1920, 1080));
    check("first upload is accepted", first.status === 201, `status ${first.status}`);

    const afterFirst = await prisma.screenshot.findMany({
      where: { userId: user.id },
      select: { id: true, storageKey: true, width: true, height: true },
    });
    check("it created exactly one row", afterFirst.length === 1, `${afterFirst.length} rows`);
    check(
      "the dimensions came from the JPEG, not the client",
      afterFirst[0]?.width === 1920 && afterFirst[0]?.height === 1080,
      `${afterFirst[0]?.width}×${afterFirst[0]?.height}`,
    );
    check(
      "the file is on disk",
      afterFirst[0] ? await exists(afterFirst[0].storageKey) : false,
    );

    const second = await upload(accessToken, fakeJpeg(1920, 1080));
    check("an immediate second upload is refused with 429", second.status === 429, `status ${second.status}`);
    check("it carries Retry-After", Number(second.retryAfter) > 0, String(second.retryAfter));
    check("it names the reason", second.body.error === "rate_limited", String(second.body.error));

    check(
      "the refused upload created no row",
      (await prisma.screenshot.count({ where: { userId: user.id } })) === 1,
    );

    // A client lying about when it captured cannot buy itself a slot: the
    // limiter reads the server's clock and a column only the server writes.
    const backdated = await upload(
      accessToken,
      fakeJpeg(1920, 1080),
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );
    check(
      "a doctored capturedAt does not bypass it",
      backdated.status === 429,
      `status ${backdated.status}`,
    );
    check(
      "and still created no row",
      (await prisma.screenshot.count({ where: { userId: user.id } })) === 1,
    );

    // Move the device's own clock back rather than waiting out the window: the
    // column *is* the limiter's whole state, so this is the same thing as time
    // passing, and it is what makes this test run in a second.
    await prisma.monitorDevice.update({
      where: { id: device.id },
      data: { lastScreenshotAt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    });

    const third = await upload(accessToken, fakeJpeg(1280, 720));
    check("an upload after the window is accepted", third.status === 201, `status ${third.status}`);
    check(
      "and created a second row",
      (await prisma.screenshot.count({ where: { userId: user.id } })) === 2,
    );

    // A refused *store* must not cost the window. An oversized-by-content body
    // (not a JPEG) is rejected by `validateScreenshot` after the slot is
    // claimed, so the slot has to come back.
    await prisma.monitorDevice.update({
      where: { id: device.id },
      data: { lastScreenshotAt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    });
    const rejected = await upload(accessToken, new Uint8Array(Buffer.alloc(4096, 0x41)));
    check("a non-JPEG body is rejected", rejected.status === 415, `status ${rejected.status}`);

    const releasedRow = await prisma.monitorDevice.findUnique({
      where: { id: device.id },
      select: { lastScreenshotAt: true },
    });
    check(
      "a rejected upload hands its rate-limit slot back",
      (releasedRow?.lastScreenshotAt?.getTime() ?? 0) < Date.now() - 60 * 60 * 1000,
      String(releasedRow?.lastScreenshotAt),
    );

    // -----------------------------------------------------------------------
    console.log("\nRetention");
    // -----------------------------------------------------------------------
    const { runScreenshotRetention } = await import("../lib/screenshotRetention");
    const { capturePolicy, retentionDays } = await import("../lib/screenshotPolicy");

    const rows = await prisma.screenshot.findMany({
      where: { userId: user.id },
      select: { id: true, storageKey: true },
      orderBy: { createdAt: "asc" },
    });

    const [old, recent] = rows;
    if (!old || !recent) throw new Error("expected two screenshots to test retention with");

    // Old enough for any sane retention window, stamped on `created_at` — the
    // server's own column, which is the only thing the sweep looks at.
    await prisma.screenshot.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });

    // A third row whose file is already gone, to prove a missing file does not
    // stop the row being cleaned up.
    const orphanKey = `1999/01/01/${user.id}/${Date.now()}-${randomBytes(8).toString("hex")}.jpg`;
    const orphanPath = path.resolve(storageRoot(), orphanKey);
    await mkdir(path.dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, Buffer.from(fakeJpeg(800, 600)));
    const orphan = await prisma.screenshot.create({
      data: {
        userId: user.id,
        workSessionId: (await prisma.workSession.findFirstOrThrow({
          where: { userId: user.id },
          select: { id: true },
        })).id,
        deviceId: device.id,
        capturedAt: new Date(),
        storageKey: orphanKey,
        width: 800,
        height: 600,
        fileSize: 4096,
        format: "image/jpeg",
        displayId: "test",
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });
    await rm(orphanPath, { force: true });
    check("the orphan's file really is gone before the sweep", !(await exists(orphanKey)));

    const result = await runScreenshotRetention();

    check(
      "the sweep reports the configured window",
      result.retentionDays === retentionDays(),
      `${result.retentionDays} vs ${retentionDays()}`,
    );
    check(
      "the aged screenshot's row is gone",
      (await prisma.screenshot.findUnique({ where: { id: old.id }, select: { id: true } })) === null,
    );
    check("its file is gone too", !(await exists(old.storageKey)));
    check(
      "the row whose file was already missing is gone",
      (await prisma.screenshot.findUnique({ where: { id: orphan.id }, select: { id: true } })) ===
        null,
    );
    check("the sweep counted that as missing, not as a failure", result.filesMissing >= 1 && result.failed === 0, JSON.stringify(result));
    check(
      "the recent screenshot survived",
      (await prisma.screenshot.findUnique({ where: { id: recent.id }, select: { id: true } })) !==
        null,
    );
    check("and so did its file", await exists(recent.storageKey));

    // -----------------------------------------------------------------------
    console.log("\nInvalid configuration falls back");
    // -----------------------------------------------------------------------
    const saved = { ...process.env };

    process.env.SCREENSHOT_RETENTION_DAYS = "not-a-number";
    check("a nonsense retention window falls back to 30", retentionDays() === 30);
    process.env.SCREENSHOT_RETENTION_DAYS = "0";
    check("zero days falls back to 30", retentionDays() === 30);
    process.env.SCREENSHOT_RETENTION_DAYS = "999999";
    check("an absurd retention window falls back to 30", retentionDays() === 30);
    process.env.SCREENSHOT_RETENTION_DAYS = "7";
    check("a valid one is honoured", retentionDays() === 7);

    process.env.SCREENSHOT_MIN_INTERVAL_MINUTES = "40";
    process.env.SCREENSHOT_MAX_INTERVAL_MINUTES = "";
    check(
      "min above the default max falls back to 10–30",
      capturePolicy().minIntervalSeconds === 600 && capturePolicy().maxIntervalSeconds === 1800,
      JSON.stringify(capturePolicy()),
    );
    process.env.SCREENSHOT_MIN_INTERVAL_MINUTES = "15";
    process.env.SCREENSHOT_MAX_INTERVAL_MINUTES = "45";
    check(
      "a valid pair is honoured",
      capturePolicy().minIntervalSeconds === 900 && capturePolicy().maxIntervalSeconds === 2700,
      JSON.stringify(capturePolicy()),
    );

    process.env.SCREENSHOT_MIN_INTERVAL_SECONDS = "10";
    process.env.SCREENSHOT_MAX_INTERVAL_SECONDS = "20";
    check(
      "the seconds override is honoured outside production",
      capturePolicy().source === "test",
      capturePolicy().source,
    );

    // `NODE_ENV` is typed read-only, and writing it through the index signature
    // is the only way to move it — which is the whole point of this assertion:
    // no combination of the other variables can produce a `test` cadence on a
    // production server.
    (process.env as Record<string, string>).NODE_ENV = "production";
    check(
      "the seconds override is IGNORED in production",
      capturePolicy().source !== "test",
      capturePolicy().source,
    );

    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  } finally {
    // Every file this test wrote, then the user — whose cascade takes the work
    // session, the device and the screenshot rows with it.
    const leftovers = await prisma.screenshot
      .findMany({ where: { userId: user.id }, select: { storageKey: true } })
      .catch(() => []);
    for (const row of leftovers) {
      await rm(path.resolve(storageRoot(), row.storageKey), { force: true }).catch(() => {});
    }
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("\nThe test run itself failed:", error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
