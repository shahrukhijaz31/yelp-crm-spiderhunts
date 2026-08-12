import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import { newStorageKey, putScreenshot, storageRoot } from "../lib/screenshotStorage";

/**
 * End-to-end check of the admin screenshot viewer, against a running server and
 * a real database.
 *
 *   npm run dev                      (in one terminal)
 *   npm run test:screenshot-viewer   (in another)
 *
 * Written for the same reason `test-screenshots.ts` was: this repository has no
 * test framework, and none of the claims worth checking here are unit-testable
 * in any useful sense. "An agent gets a 403 from the image route" is a claim
 * about a cookie, a session row, a role column and an HTTP handler; a mocked
 * version of it would pass whether or not the real thing works. So this speaks
 * HTTP to the real routes with real session cookies and checks what actually
 * comes back.
 *
 * It creates a throwaway administrator and two throwaway agents (`viewtest-*`),
 * their shifts, their sessions and a handful of screenshots with real files on
 * disk — and deletes all of it on the way out, including after a failure. It
 * never touches an existing user, shift, session or screenshot.
 *
 * **Sessions are inserted directly rather than signed in for.** A real portal
 * sign-in needs a six-digit code delivered by email, which a test cannot read.
 * The token construction is copied from `lib/session.ts` (32 random bytes,
 * SHA-256 into the row) so what the routes authenticate is exactly what they
 * authenticate in production.
 *
 * **Screenshot rows are inserted directly rather than uploaded.** The upload
 * path is Stage 5's and is covered by `test-screenshots.ts`; going through it
 * here would mean fighting the rate limiter to produce a day's worth of
 * captures, and would couple a test of the viewer to a route it does not use.
 * The rows and files this writes are the same shape the upload route produces —
 * `newStorageKey` and `putScreenshot` are the very functions it calls.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "viewer-test-Pa55phrase";

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

/** A minimal JPEG whose SOF0 states the dimensions. Same trick as Stage 5's. */
function fakeJpeg(width: number, height: number, padding = 2048): Uint8Array {
  const comment = Buffer.alloc(2 + 2 + padding);
  comment.writeUInt8(0xff, 0);
  comment.writeUInt8(0xfe, 1); // COM
  comment.writeUInt16BE(2 + padding, 2);

  const sof = Buffer.alloc(2 + 2 + 6);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1); // SOF0
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

  return new Uint8Array(
    joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.length),
  );
}

/** Mint a portal session for a user and return the cookie header value. */
async function signIn(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  await prisma.session.create({
    data: {
      tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
      userId,
      expiresAt: new Date(now + 12 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      userAgent: "screenshot-viewer-test",
      ipAddress: "127.0.0.1",
    },
  });

  return `${SESSION_COOKIE}=${token}`;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  raw: string;
  headers: Headers;
}

async function get(url: string, cookie?: string): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${url}`, {
    headers: cookie ? { cookie } : {},
    // The portal redirects unauthenticated *pages*; the API answers 401. Either
    // way a redirect must not be followed, or the status under test is lost.
    redirect: "manual",
  });

  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }

  return { status: response.status, body, raw, headers: response.headers };
}

/** Local midnight plus a time of day, as an instant. */
function at(hours: number, minutes: number, dayOffset = 0): Date {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
}

function isoDay(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const storageKeys: string[] = [];

  console.log(`\nAdmin screenshot viewer — ${BASE_URL}\n`);

  const [admin, alice, bob] = await Promise.all(
    (
      [
        ["viewadmin", "Viewer Test Admin", "ADMIN"],
        ["viewalice", "Viewer Test Alice", "AGENT"],
        ["viewbob", "Viewer Test Bob", "AGENT"],
      ] as const
    ).map(async ([stem, name, role]) =>
      prisma.user.create({
        data: {
          username: `viewtest-${stem}-${suffix}`,
          email: `viewtest-${stem}-${suffix}@example.invalid`,
          name: `${name} ${suffix}`,
          passwordHash: await hashPassword(PASSWORD),
          role,
          isActive: true,
        },
        select: { id: true, name: true },
      }),
    ),
  );

  try {
    // Two shifts for Alice today, one for Bob, plus one for Alice yesterday.
    const [aliceMorning, aliceAfternoon, bobShift, aliceYesterday] = await Promise.all([
      prisma.workSession.create({
        data: {
          userId: alice.id,
          startedAt: at(9, 4),
          lastSeenAt: at(12, 30),
          endedAt: at(12, 30),
          durationSeconds: 12_360,
        },
        select: { id: true },
      }),
      prisma.workSession.create({
        data: {
          userId: alice.id,
          startedAt: at(13, 15),
          lastSeenAt: at(17, 32),
          endedAt: at(17, 32),
          durationSeconds: 15_420,
        },
        select: { id: true },
      }),
      prisma.workSession.create({
        data: {
          userId: bob.id,
          startedAt: at(10, 0),
          lastSeenAt: at(16, 0),
          endedAt: at(16, 0),
          durationSeconds: 21_600,
        },
        select: { id: true },
      }),
      prisma.workSession.create({
        data: {
          userId: alice.id,
          startedAt: at(9, 0, -1),
          lastSeenAt: at(17, 0, -1),
          endedAt: at(17, 0, -1),
          durationSeconds: 28_800,
        },
        select: { id: true },
      }),
    ]);

    /**
     * The screenshots under test.
     *
     * Deliberately spread across two agents, two shifts, two days and a range
     * of times, because every filter below is checked by counting how many of
     * these come back — a fixture that was all one agent at one time could not
     * tell a working filter from one that ignores its parameter.
     */
    const fixtures: Array<{
      userId: string;
      workSessionId: string;
      capturedAt: Date;
      width: number;
      height: number;
    }> = [
      { userId: alice.id, workSessionId: aliceMorning.id, capturedAt: at(9, 20), width: 1920, height: 1080 },
      { userId: alice.id, workSessionId: aliceMorning.id, capturedAt: at(10, 45), width: 1920, height: 1080 },
      { userId: alice.id, workSessionId: aliceMorning.id, capturedAt: at(11, 55), width: 1920, height: 1080 },
      { userId: alice.id, workSessionId: aliceAfternoon.id, capturedAt: at(14, 32), width: 2560, height: 1440 },
      { userId: alice.id, workSessionId: aliceAfternoon.id, capturedAt: at(16, 10), width: 2560, height: 1440 },
      { userId: bob.id, workSessionId: bobShift.id, capturedAt: at(10, 15), width: 1366, height: 768 },
      { userId: bob.id, workSessionId: bobShift.id, capturedAt: at(15, 40), width: 1366, height: 768 },
      { userId: alice.id, workSessionId: aliceYesterday.id, capturedAt: at(11, 0, -1), width: 1920, height: 1080 },
    ];

    const created: Array<{ id: string; storageKey: string }> = [];
    for (const fixture of fixtures) {
      const bytes = fakeJpeg(fixture.width, fixture.height);
      const key = newStorageKey("image/jpeg", fixture.userId, fixture.capturedAt);
      const size = await putScreenshot(key, bytes);
      storageKeys.push(key);

      const row = await prisma.screenshot.create({
        data: {
          userId: fixture.userId,
          workSessionId: fixture.workSessionId,
          capturedAt: fixture.capturedAt,
          storageKey: key,
          width: fixture.width,
          height: fixture.height,
          fileSize: size,
          format: "image/jpeg",
          displayId: "2528732444",
        },
        select: { id: true },
      });
      created.push({ id: row.id, storageKey: key });
    }

    // A ninth row whose file is deliberately not on disk, for the 410 path.
    const orphanKey = newStorageKey("image/jpeg", alice.id, at(17, 0));
    const orphan = await prisma.screenshot.create({
      data: {
        userId: alice.id,
        workSessionId: aliceAfternoon.id,
        capturedAt: at(17, 0),
        storageKey: orphanKey,
        width: 1920,
        height: 1080,
        fileSize: 4096,
        format: "image/jpeg",
        displayId: "2528732444",
      },
      select: { id: true },
    });

    const adminCookie = await signIn(admin.id);
    const agentCookie = await signIn(alice.id);

    const anyShot = created[0]!;

    // -----------------------------------------------------------------------
    console.log("A signed-out caller reaches nothing");
    // -----------------------------------------------------------------------
    for (const [label, url] of [
      ["the list", "/api/screenshots"],
      ["the metadata", `/api/screenshots/${anyShot.id}`],
      ["the image", `/api/screenshots/${anyShot.id}/image`],
    ] as const) {
      const reply = await get(url);
      check(
        `${label} answers 401 with no session`,
        reply.status === 401,
        `status ${reply.status}`,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nAn authenticated AGENT reaches nothing either");
    // -----------------------------------------------------------------------
    for (const [label, url] of [
      ["the list", "/api/screenshots"],
      ["the metadata", `/api/screenshots/${anyShot.id}`],
      ["the image", `/api/screenshots/${anyShot.id}/image`],
    ] as const) {
      const reply = await get(url, agentCookie);
      check(
        `${label} answers 403 for an agent`,
        reply.status === 403,
        `status ${reply.status}`,
      );
    }

    {
      // The agent asking for their *own* screenshot is still refused. This is
      // the one that separates "screenshots are private to their subject" from
      // "screenshots are for administrators", and it is the latter.
      const own = created.find((row) =>
        fixtures[created.indexOf(row)]!.userId === alice.id,
      )!;
      const reply = await get(`/api/screenshots/${own.id}/image`, agentCookie);
      check(
        "an agent cannot read their own screenshot either",
        reply.status === 403,
        `status ${reply.status}`,
      );
    }

    {
      const reply = await get("/screenshots", agentCookie);
      check(
        "the page itself does not 200 into a gallery for an agent",
        // `requireRole` renders Access Denied rather than redirecting, so a 200
        // is expected — what must not appear is any screenshot in the markup.
        reply.status !== 200 || !reply.raw.includes("/api/screenshots/"),
        `status ${reply.status}`,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nAn ADMIN sees today's screenshots");
    // -----------------------------------------------------------------------
    const todayReply = await get("/api/screenshots", adminCookie);
    check("the list answers 200 for an admin", todayReply.status === 200, `status ${todayReply.status}`);

    const payload = todayReply.body as {
      screenshots?: Array<Record<string, unknown>>;
      meta?: { total?: number; page?: number; totalPages?: number; pageSize?: number };
      summary?: { inWindow?: number; activeAgents?: number; latestCaptureAt?: string | null };
      timeline?: Array<Record<string, unknown>>;
      sessions?: Array<Record<string, unknown>>;
    };

    const mine = (payload.screenshots ?? []).filter((row) =>
      created.some((fixture) => fixture.id === row.id) || row.id === orphan.id,
    );

    check(
      "today's captures are all present",
      // Seven of the eight fixtures are today, plus the orphan row = 8.
      mine.length === 8,
      `found ${mine.length}`,
    );
    check(
      "yesterday's capture is not in today's view",
      !(payload.screenshots ?? []).some(
        (row) => row.id === created[created.length - 1]!.id,
      ),
    );
    check(
      "the default page size is 50",
      payload.meta?.pageSize === 50,
      String(payload.meta?.pageSize),
    );
    check(
      "the summary counts distinct agents",
      (payload.summary?.activeAgents ?? 0) >= 2,
      String(payload.summary?.activeAgents),
    );
    check(
      "the summary total matches the page meta",
      payload.summary?.inWindow === payload.meta?.total,
      `${payload.summary?.inWindow} vs ${payload.meta?.total}`,
    );
    check(
      "the timeline has a point per capture in the window",
      (payload.timeline?.length ?? 0) === (payload.meta?.total ?? -1),
      `${payload.timeline?.length} vs ${payload.meta?.total}`,
    );
    check("the shift picker is populated", (payload.sessions?.length ?? 0) >= 3);

    // -----------------------------------------------------------------------
    console.log("\nNo filesystem detail escapes");
    // -----------------------------------------------------------------------
    const root = storageRoot();
    check(
      "no storage key appears in the list response",
      !storageKeys.some((key) => todayReply.raw.includes(key)),
    );
    check(
      "no 'storageKey' field appears at all",
      !todayReply.raw.includes("storageKey"),
    );
    check(
      "the storage root is not named in the response",
      !todayReply.raw.includes(root) &&
        !todayReply.raw.includes(root.replace(/\\/g, "/")) &&
        !todayReply.raw.includes(".data/screenshots"),
    );

    // -----------------------------------------------------------------------
    console.log("\nFilters");
    // -----------------------------------------------------------------------
    {
      const reply = await get(`/api/screenshots?agent=${alice.id}`, adminCookie);
      const rows = (reply.body as { screenshots?: Array<{ agent?: { id?: string } }> })
        .screenshots ?? [];
      check(
        "the agent filter returns only that agent",
        rows.length === 6 && rows.every((row) => row.agent?.id === alice.id),
        `${rows.length} rows`,
      );
    }

    {
      const reply = await get(`/api/screenshots?agent=${bob.id}`, adminCookie);
      const rows = (reply.body as { screenshots?: unknown[] }).screenshots ?? [];
      check("a second agent filters independently", rows.length === 2, `${rows.length} rows`);
    }

    {
      const reply = await get("/api/screenshots?date=yesterday", adminCookie);
      const rows = (reply.body as { screenshots?: Array<{ id?: string }> }).screenshots ?? [];
      check(
        "the yesterday filter finds yesterday's capture",
        rows.some((row) => row.id === created[created.length - 1]!.id),
        `${rows.length} rows`,
      );
    }

    {
      const day = isoDay(at(12, 0, -1));
      const reply = await get(`/api/screenshots?date=custom&day=${day}`, adminCookie);
      const rows = (reply.body as { screenshots?: Array<{ id?: string }> }).screenshots ?? [];
      check(
        "an explicit custom day agrees with the yesterday preset",
        rows.some((row) => row.id === created[created.length - 1]!.id),
        `${rows.length} rows`,
      );
    }

    {
      const reply = await get(
        `/api/screenshots?session=${aliceMorning.id}`,
        adminCookie,
      );
      const rows =
        (reply.body as { screenshots?: Array<{ workSession?: { id?: string } }> })
          .screenshots ?? [];
      check(
        "the work-session filter returns only that shift",
        rows.length === 3 && rows.every((row) => row.workSession?.id === aliceMorning.id),
        `${rows.length} rows`,
      );
    }

    {
      const reply = await get("/api/screenshots?from=13:00&to=17:00", adminCookie);
      const rows = (reply.body as { screenshots?: Array<{ capturedAt?: string }> })
        .screenshots ?? [];
      // 14:32, 15:40 and 16:10 — and not the 17:00 orphan, since `to` is exclusive.
      check("the time range filters to the afternoon", rows.length === 3, `${rows.length} rows`);
      check(
        "every row is inside the requested hours",
        rows.every((row) => {
          const hour = new Date(row.capturedAt!).getHours();
          return hour >= 13 && hour < 17;
        }),
      );
    }

    {
      const reply = await get(
        `/api/screenshots?agent=${alice.id}&session=${aliceAfternoon.id}&from=14:00&to=15:00`,
        adminCookie,
      );
      const rows = (reply.body as { screenshots?: unknown[] }).screenshots ?? [];
      check("filters compose", rows.length === 1, `${rows.length} rows`);
    }

    {
      const reply = await get("/api/screenshots?date=nonsense&agent=%2e%2e%2f&page=-4", adminCookie);
      check(
        "a hostile query string is clamped, not fatal",
        reply.status === 200,
        `status ${reply.status}`,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nPagination");
    // -----------------------------------------------------------------------
    {
      const first = await get("/api/screenshots?pageSize=25&page=1", adminCookie);
      const meta = (first.body as { meta?: { pageSize?: number; totalPages?: number } }).meta;
      check("an allowed page size is honoured", meta?.pageSize === 25, String(meta?.pageSize));

      const rejected = await get("/api/screenshots?pageSize=7", adminCookie);
      check(
        "a page size outside the allowed set falls back to the default",
        (rejected.body as { meta?: { pageSize?: number } }).meta?.pageSize === 50,
      );
    }

    {
      // Two pages of one row each, out of the same filter, must not overlap.
      const one = await get(`/api/screenshots?agent=${bob.id}&pageSize=25&page=1`, adminCookie);
      const two = await get(`/api/screenshots?agent=${bob.id}&pageSize=25&page=2`, adminCookie);
      const onePage = (one.body as { screenshots?: Array<{ id: string }> }).screenshots ?? [];
      const twoPage = (two.body as { screenshots?: Array<{ id: string }> }).screenshots ?? [];

      check("page 1 holds both of Bob's captures at 25 per page", onePage.length === 2);
      check("page 2 of a one-page result is empty", twoPage.length === 0);
      check(
        "totalPages is computed from the filtered total",
        (one.body as { meta?: { totalPages?: number } }).meta?.totalPages === 1,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nOne screenshot, and its bytes");
    // -----------------------------------------------------------------------
    {
      const reply = await get(`/api/screenshots/${anyShot.id}`, adminCookie);
      const shot = (reply.body as { screenshot?: Record<string, unknown> }).screenshot;
      check("the metadata route answers 200", reply.status === 200, `status ${reply.status}`);
      check("it carries the agent and the shift", Boolean(shot?.agent) && Boolean(shot?.workSession));
      check("it does not carry a storage key", !reply.raw.includes("storageKey"));
    }

    {
      const response = await fetch(`${BASE_URL}/api/screenshots/${anyShot.id}/image`, {
        headers: { cookie: adminCookie },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());

      check("the image route answers 200", response.status === 200, `status ${response.status}`);
      check(
        "it is served as image/jpeg",
        response.headers.get("content-type") === "image/jpeg",
        String(response.headers.get("content-type")),
      );
      check("it forbids MIME sniffing", response.headers.get("x-content-type-options") === "nosniff");
      check(
        "it is not cacheable",
        (response.headers.get("cache-control") ?? "").includes("no-store"),
        String(response.headers.get("cache-control")),
      );
      check(
        "the filename in Content-Disposition is not a storage path",
        !(response.headers.get("content-disposition") ?? "").includes("/"),
        String(response.headers.get("content-disposition")),
      );
      check(
        "the bytes are the JPEG that was stored",
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.byteLength > 1024,
        `${bytes.byteLength} bytes`,
      );
      check(
        "Content-Length matches the body",
        Number(response.headers.get("content-length")) === bytes.byteLength,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nIds that are not screenshots");
    // -----------------------------------------------------------------------
    {
      const missing = await get("/api/screenshots/clnotarealidatall000000/image", adminCookie);
      check("an unknown id is a 404", missing.status === 404, `status ${missing.status}`);

      const missingMeta = await get("/api/screenshots/clnotarealidatall000000", adminCookie);
      check("its metadata is a 404 too", missingMeta.status === 404, `status ${missingMeta.status}`);
    }

    {
      // The row is real, the file is not. A different answer from "no such
      // screenshot", and it must not be a 200 with an empty body.
      const reply = await get(`/api/screenshots/${orphan.id}/image`, adminCookie);
      check(
        "a row whose object is missing is a 410, never a 200",
        reply.status === 410,
        `status ${reply.status}`,
      );
    }

    {
      /*
       * Traversal, in the shapes it is usually attempted.
       *
       * None of these can work by construction — the id is a database primary
       * key and the storage key is read off the row — but the check is cheap
       * and it is the property most worth never regressing. A 200 here would
       * mean the route had grown a way to name a file.
       */
      const attempts = [
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "....//....//package.json",
        encodeURIComponent("../../../../.env"),
        encodeURIComponent(storageKeys[0]!),
        encodeURIComponent(path.resolve(root, storageKeys[0]!)),
      ];

      for (const attempt of attempts) {
        const reply = await get(`/api/screenshots/${attempt}/image`, adminCookie);
        check(
          `traversal attempt is refused: ${decodeURIComponent(attempt).slice(0, 40)}`,
          reply.status !== 200,
          `status ${reply.status}`,
        );
      }
    }

    {
      // And the same attempts unauthenticated, which must never get further.
      const reply = await get("/api/screenshots/..%2F..%2F.env/image");
      check(
        "traversal signed out is still a 401, not a 404 that read the disk",
        reply.status === 401,
        `status ${reply.status}`,
      );
    }
  } finally {
    // ---------------------------------------------------------------------
    // Teardown. Runs after a failure too — a test that leaves users, shifts
    // and image files behind is a test nobody runs twice.
    // ---------------------------------------------------------------------
    const ids = [admin.id, alice.id, bob.id];

    await prisma.screenshot.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.workSession.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});

    for (const key of storageKeys) {
      await rm(path.resolve(storageRoot(), key), { force: true }).catch(() => {});
    }

    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("\nThe test run itself failed:\n", error);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
