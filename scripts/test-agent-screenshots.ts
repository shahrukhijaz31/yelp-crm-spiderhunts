import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import { newStorageKey, putScreenshot, storageRoot } from "../lib/screenshotStorage";
import {
  MY_SCREENSHOT_MAX_PAGE_SIZE,
  encodeMyScreenshotCursor,
} from "../lib/myScreenshotsRules";

/**
 * The agent's own screenshot view, and the boundary around it.
 *
 *   npm run dev                    (in one terminal)
 *   npm run test:agent-screenshots (in another)
 *
 * Written for the reason `test-screenshot-viewer.ts` gives: every claim worth
 * checking here is a claim about a cookie, a session row, a role column, a
 * `where` clause and an HTTP status. A mocked version of any of them would pass
 * whether or not the real thing works, so this speaks HTTP to the real routes
 * with real session cookies and checks what actually comes back.
 *
 * The question it exists to answer is not "does the gallery load". It is
 * whether an agent holding a valid session and a text editor can reach one
 * single byte belonging to somebody else — by changing a screenshot id, by
 * adding a `userId`, by replaying another agent's cursor, by asking for a
 * storage key, by calling the admin API, or by trying to delete anything at
 * all. Every one of those is below, and every one of them must fail.
 *
 * It creates a throwaway administrator and two throwaway agents (`mysstest-*`),
 * their shifts, their sessions, an activity interval and a handful of
 * screenshots with real files on disk — and deletes all of it on the way out,
 * including after a failure. It never touches an existing user, shift, session
 * or screenshot, and the only delete it performs is against a screenshot it
 * created itself, to prove the administrator's own path still works.
 *
 * Sessions are inserted directly rather than signed in for: a real portal
 * sign-in needs a six-digit code delivered by email, which a test cannot read.
 * The token construction is copied from `lib/session.ts`, so what the routes
 * authenticate is exactly what they authenticate in production.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "agent-screenshots-test-Pa55phrase";
const origin = new URL(BASE_URL).origin;

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

const MINE = "/api/performance/me/screenshots";

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
      userAgent: "agent-screenshots-test",
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

/** Headers a browser on this origin would send with a state-changing request. */
function sameOriginHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

async function send(
  method: string,
  url: string,
  cookie: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: sameOriginHeaders(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  return { status: response.status, body: parsed, raw, headers: response.headers };
}

interface ListRow {
  id: string;
  capturedAt: string;
  activityPercentage: number | null;
}

function rowsOf(reply: Reply): ListRow[] {
  return (reply.body.screenshots as ListRow[] | undefined) ?? [];
}

/** Local midnight plus a time of day, as an instant. */
function at(hours: number, minutes: number, dayOffset = 0): Date {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
}

async function main(): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const storageKeys: string[] = [];

  console.log(`\nAgent screenshots — read-only, own rows only — ${BASE_URL}\n`);

  const [admin, alice, bob] = await Promise.all(
    (
      [
        ["myssadmin", "My Screenshots Admin", "ADMIN"],
        ["myssalice", "My Screenshots Alice", "AGENT"],
        ["myssbob", "My Screenshots Bob", "AGENT"],
      ] as const
    ).map(async ([stem, name, role]) =>
      prisma.user.create({
        data: {
          username: `mysstest-${stem}-${suffix}`,
          email: `mysstest-${stem}-${suffix}@example.invalid`,
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
    const [aliceShift, bobShift] = await Promise.all([
      prisma.workSession.create({
        data: {
          userId: alice.id,
          startedAt: at(9, 0),
          lastSeenAt: at(17, 0),
          endedAt: at(17, 0),
          durationSeconds: 28_800,
        },
        select: { id: true },
      }),
      prisma.workSession.create({
        data: {
          userId: bob.id,
          startedAt: at(9, 30),
          lastSeenAt: at(16, 30),
          endedAt: at(16, 30),
          durationSeconds: 25_200,
        },
        select: { id: true },
      }),
    ]);

    /*
     * Alice gets five captures and Bob two, deliberately unequal: a scoping bug
     * that returned everybody's rows would be invisible against a fixture where
     * both agents have the same number.
     */
    const fixtures = [
      { owner: alice, shift: aliceShift.id, capturedAt: at(9, 20) },
      { owner: alice, shift: aliceShift.id, capturedAt: at(10, 45) },
      { owner: alice, shift: aliceShift.id, capturedAt: at(11, 55) },
      { owner: alice, shift: aliceShift.id, capturedAt: at(14, 32) },
      { owner: alice, shift: aliceShift.id, capturedAt: at(16, 10) },
      { owner: bob, shift: bobShift.id, capturedAt: at(10, 15) },
      { owner: bob, shift: bobShift.id, capturedAt: at(15, 40) },
    ];

    const created: Array<{ id: string; userId: string; storageKey: string; capturedAt: Date }> =
      [];

    for (const fixture of fixtures) {
      const bytes = fakeJpeg(1920, 1080);
      const key = newStorageKey("image/jpeg", fixture.owner.id, fixture.capturedAt);
      const size = await putScreenshot(key, bytes);
      storageKeys.push(key);

      const row = await prisma.screenshot.create({
        data: {
          userId: fixture.owner.id,
          workSessionId: fixture.shift,
          capturedAt: fixture.capturedAt,
          storageKey: key,
          width: 1920,
          height: 1080,
          fileSize: size,
          format: "image/jpeg",
          displayId: "2528732444",
        },
        select: { id: true },
      });

      created.push({
        id: row.id,
        userId: fixture.owner.id,
        storageKey: key,
        capturedAt: fixture.capturedAt,
      });
    }

    const aliceShots = created.filter((row) => row.userId === alice.id);
    const bobShots = created.filter((row) => row.userId === bob.id);
    const bobShot = bobShots[0]!;

    /*
     * One activity interval covering Alice's 10:45 capture, so the metadata the
     * card shows is checked against a row that exists rather than only against
     * the nulls an empty table would produce.
     */
    await prisma.activityInterval.create({
      data: {
        userId: alice.id,
        workSessionId: aliceShift.id,
        startedAt: at(10, 45),
        endedAt: at(10, 46),
        durationSeconds: 60,
        keyboardActivityCount: 120,
        mouseActivityCount: 80,
        activityPercentage: 67,
        clientKey: `mysstest-${suffix}-a`,
      },
    });

    // A row of Alice's whose file is deliberately not on disk, for the 410 path.
    const orphanKey = newStorageKey("image/jpeg", alice.id, at(17, 30));
    const orphan = await prisma.screenshot.create({
      data: {
        userId: alice.id,
        workSessionId: aliceShift.id,
        capturedAt: at(17, 30),
        storageKey: orphanKey,
        width: 1920,
        height: 1080,
        fileSize: 4096,
        format: "image/jpeg",
        displayId: "2528732444",
      },
      select: { id: true },
    });

    // A sixth real capture of Alice's, created only so the administrator can
    // delete something at the end without touching anything else under test.
    const doomedKey = newStorageKey("image/jpeg", alice.id, at(18, 0));
    const doomedSize = await putScreenshot(doomedKey, fakeJpeg(1280, 720));
    storageKeys.push(doomedKey);
    const doomed = await prisma.screenshot.create({
      data: {
        userId: alice.id,
        workSessionId: aliceShift.id,
        capturedAt: at(18, 0),
        storageKey: doomedKey,
        width: 1280,
        height: 720,
        fileSize: doomedSize,
        format: "image/jpeg",
        displayId: "2528732444",
      },
      select: { id: true },
    });

    /** Everything of Alice's the list endpoint should be able to reach. */
    const aliceTotal = aliceShots.length + 2; // + the orphan row + the doomed one

    const adminCookie = await signIn(admin.id);
    const aliceCookie = await signIn(alice.id);
    const bobCookie = await signIn(bob.id);

    // -----------------------------------------------------------------------
    section("1. An agent can list their own screenshots");
    // -----------------------------------------------------------------------
    {
      const reply = await get(`${MINE}?limit=${MY_SCREENSHOT_MAX_PAGE_SIZE}`, aliceCookie);
      const rows = rowsOf(reply);
      const ids = new Set(rows.map((row) => row.id));

      check("the list answers 200", reply.status === 200, `status ${reply.status}`);
      check(
        "it returns every one of this agent's captures",
        rows.length === aliceTotal,
        `${rows.length} rows, expected ${aliceTotal}`,
      );
      check(
        "and not one row belonging to the other agent",
        bobShots.every((shot) => !ids.has(shot.id)),
      );
      check(
        "it is newest first",
        rows.every(
          (row, index) =>
            index === 0 ||
            new Date(rows[index - 1]!.capturedAt) >= new Date(row.capturedAt),
        ),
      );
      check(
        "it is not cacheable",
        (reply.headers.get("cache-control") ?? "").includes("no-store"),
        String(reply.headers.get("cache-control")),
      );
    }

    // -----------------------------------------------------------------------
    section("2. The payload carries no key, no path and nobody else");
    // -----------------------------------------------------------------------
    {
      const reply = await get(MINE, aliceCookie);

      check("it does not carry a storage key field", !reply.raw.includes("storageKey"));
      check(
        "no storage key value appears anywhere in it",
        storageKeys.every((key) => !reply.raw.includes(key)),
      );
      check(
        "no path fragment of the storage root appears in it",
        !reply.raw.includes(storageRoot()),
      );
      check("it does not carry a user id", !reply.raw.includes(alice.id));
      check(
        "it names no other user, by id or by name",
        !reply.raw.includes(bob.id) && !reply.raw.includes(bob.name),
      );
      check(
        "the metadata the gallery shows is present",
        rowsOf(reply).every(
          (row) =>
            typeof row.capturedAt === "string" && "activityPercentage" in row,
        ),
      );
      check(
        "the activity figure recorded for one capture came through",
        rowsOf(reply).some((row) => row.activityPercentage === 67),
      );
    }

    // -----------------------------------------------------------------------
    section("3. Pagination — a page at a time, and never the whole table");
    // -----------------------------------------------------------------------
    {
      const first = await get(`${MINE}?limit=2`, aliceCookie);
      const firstRows = rowsOf(first);

      check("a limit of 2 returns 2 rows", firstRows.length === 2, `${firstRows.length}`);
      check("it says there is more", first.body.hasMore === true);
      check("it hands back a cursor", typeof first.body.nextCursor === "string");

      const second = await get(
        `${MINE}?limit=2&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
        aliceCookie,
      );
      const secondRows = rowsOf(second);
      const firstIds = new Set(firstRows.map((row) => row.id));

      check("the next page returns 2 more rows", secondRows.length === 2);
      check(
        "with no overlap against the first",
        secondRows.every((row) => !firstIds.has(row.id)),
      );
      check(
        "and none of them the other agent's",
        secondRows.every((row) => !bobShots.some((shot) => shot.id === row.id)),
      );

      // Walk to the end and count. A keyset that skipped or repeated a row
      // would not land on the same total the unpaged read reported.
      const walked = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Reply = await get(
          `${MINE}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          aliceCookie,
        );
        for (const row of rowsOf(page)) walked.add(row.id);
        cursor = (page.body.nextCursor as string | null) ?? null;
        pages += 1;
      } while (cursor && pages < 20);

      check(
        "walking the cursor visits every row exactly once",
        walked.size === aliceTotal,
        `${walked.size} of ${aliceTotal}`,
      );
      check("and stops", cursor === null);

      const huge = await get(`${MINE}?limit=100000`, aliceCookie);
      check(
        "an enormous limit is clamped, not honoured",
        rowsOf(huge).length <= MY_SCREENSHOT_MAX_PAGE_SIZE,
        `${rowsOf(huge).length} rows`,
      );

      const junk = await get(`${MINE}?limit=-5&cursor=not-a-cursor`, aliceCookie);
      check(
        "a nonsense cursor and limit start the list again rather than erroring",
        junk.status === 200 && rowsOf(junk).length > 0,
        `status ${junk.status}`,
      );
    }

    // -----------------------------------------------------------------------
    section("4. An agent can view their own image, and it is served safely");
    // -----------------------------------------------------------------------
    {
      const target = aliceShots[0]!;
      const response = await fetch(`${BASE_URL}${MINE}/${target.id}/image`, {
        headers: { cookie: aliceCookie },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());

      check("the image route answers 200", response.status === 200, `status ${response.status}`);
      check(
        "it is served as image/jpeg",
        response.headers.get("content-type") === "image/jpeg",
        String(response.headers.get("content-type")),
      );
      check(
        "it forbids MIME sniffing",
        response.headers.get("x-content-type-options") === "nosniff",
      );
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

      const gone = await get(`${MINE}/${orphan.id}/image`, aliceCookie);
      check(
        "one of their own rows whose file is missing is a 410, never a 200",
        gone.status === 410,
        `status ${gone.status}`,
      );
    }

    // -----------------------------------------------------------------------
    section("5. IDOR — another agent's screenshot, by every route in");
    // -----------------------------------------------------------------------
    {
      const stranger = await get(`${MINE}/${bobShot.id}/image`, aliceCookie);
      const nonexistent = await get(`${MINE}/clnotarealidatall000000/image`, aliceCookie);

      check(
        "another agent's screenshot id is a 404",
        stranger.status === 404,
        `status ${stranger.status}`,
      );
      check(
        "and it is indistinguishable from an id that never existed",
        stranger.status === nonexistent.status && stranger.raw === nonexistent.raw,
        `${stranger.status}/${nonexistent.status}`,
      );
      check(
        "the 404 leaks nothing about the row that does exist",
        !stranger.raw.includes(bob.id) && !stranger.raw.includes(bob.name),
      );

      // The same id from its owner's session, to prove the id itself is live and
      // that the 404 above was a scoping decision rather than a broken fixture.
      const owner = await get(`${MINE}/${bobShot.id}/image`, bobCookie);
      check(
        "the same id served to its actual owner is a 200",
        owner.status === 200,
        `status ${owner.status}`,
      );

      // A storage key where an id is expected. It is not a path here and must
      // not become one.
      for (const attempt of [
        encodeURIComponent(bobShot.storageKey),
        encodeURIComponent(path.resolve(storageRoot(), bobShot.storageKey)),
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "....//....//package.json",
        encodeURIComponent("../../../../.env"),
      ]) {
        const reply = await get(`${MINE}/${attempt}/image`, aliceCookie);
        check(
          `a storage key or traversal in the id is refused: ${decodeURIComponent(attempt).slice(0, 32)}`,
          reply.status !== 200,
          `status ${reply.status}`,
        );
      }
    }

    // -----------------------------------------------------------------------
    section("6. Nothing in the request can change whose list it is");
    // -----------------------------------------------------------------------
    {
      const baseline = rowsOf(await get(`${MINE}?limit=${MY_SCREENSHOT_MAX_PAGE_SIZE}`, aliceCookie))
        .map((row) => row.id)
        .sort();

      const attempts = [
        `userId=${bob.id}`,
        `agent=${bob.id}`,
        `agentId=${bob.id}`,
        `user=${bob.id}`,
        `session=${bobShift.id}`,
        `workSessionId=${bobShift.id}`,
        `userId=${bob.id}&agent=${bob.id}&session=${bobShift.id}`,
      ];

      for (const attempt of attempts) {
        const reply = await get(
          `${MINE}?limit=${MY_SCREENSHOT_MAX_PAGE_SIZE}&${attempt}`,
          aliceCookie,
        );
        const ids = rowsOf(reply).map((row) => row.id).sort();

        check(
          `?${attempt.slice(0, 44)} changes nothing`,
          reply.status === 200 &&
            ids.length === baseline.length &&
            ids.every((id, index) => id === baseline[index]),
          `${ids.length} rows, expected ${baseline.length}`,
        );
      }

      // A cursor minted from another agent's row. It is a position, not a
      // subject: it may move Alice's window, but it must not populate it with
      // Bob's rows.
      const forged = encodeMyScreenshotCursor({
        capturedAt: new Date(bobShot.capturedAt.getTime() + 60_000),
        id: bobShot.id,
      });
      const replayed = await get(
        `${MINE}?limit=${MY_SCREENSHOT_MAX_PAGE_SIZE}&cursor=${encodeURIComponent(forged)}`,
        aliceCookie,
      );
      const replayedIds = new Set(rowsOf(replayed).map((row) => row.id));

      check(
        "another agent's cursor returns none of their rows",
        replayed.status === 200 && bobShots.every((shot) => !replayedIds.has(shot.id)),
        `status ${replayed.status}`,
      );
      check(
        "every row it does return is still this agent's",
        [...replayedIds].every((id) =>
          aliceShots.some((shot) => shot.id === id) ||
          id === orphan.id ||
          id === doomed.id,
        ),
      );
    }

    // -----------------------------------------------------------------------
    section("7. The agent endpoints are read-only");
    // -----------------------------------------------------------------------
    {
      const target = aliceShots[1]!;

      for (const [method, url] of [
        ["DELETE", MINE],
        ["POST", MINE],
        ["PUT", MINE],
        ["PATCH", MINE],
        ["DELETE", `${MINE}/${target.id}/image`],
        ["POST", `${MINE}/${target.id}/image`],
        ["PATCH", `${MINE}/${target.id}/image`],
      ] as const) {
        const reply = await send(method, url, aliceCookie, { ids: [target.id] });
        check(
          `${method} ${url.replace(target.id, ":id")} is refused`,
          reply.status >= 400,
          `status ${reply.status}`,
        );
      }

      const still = await prisma.screenshot.count({ where: { id: target.id } });
      check("and the row is still there afterwards", still === 1);
    }

    // -----------------------------------------------------------------------
    section("8. The admin screenshot API is unreachable from an agent session");
    // -----------------------------------------------------------------------
    {
      const own = aliceShots[2]!;

      const probes: Array<[string, Reply]> = [
        ["GET /api/screenshots", await get("/api/screenshots", aliceCookie)],
        [
          "GET /api/screenshots?agent=<self>",
          await get(`/api/screenshots?agent=${alice.id}`, aliceCookie),
        ],
        ["GET /api/screenshots/:id", await get(`/api/screenshots/${own.id}`, aliceCookie)],
        [
          "GET /api/screenshots/:id/image (their own)",
          await get(`/api/screenshots/${own.id}/image`, aliceCookie),
        ],
        [
          "DELETE /api/admin/screenshots (bulk)",
          await send("DELETE", "/api/admin/screenshots", aliceCookie, {
            ids: [own.id, bobShot.id],
          }),
        ],
        [
          "DELETE /api/admin/screenshots/:id",
          await send("DELETE", `/api/admin/screenshots/${own.id}`, aliceCookie),
        ],
        [
          "DELETE /api/admin/screenshots/:id (another agent's)",
          await send("DELETE", `/api/admin/screenshots/${bobShot.id}`, aliceCookie),
        ],
      ];

      for (const [label, reply] of probes) {
        check(`${label} is 403`, reply.status === 403, `status ${reply.status}`);
      }

      const survivors = await prisma.screenshot.count({
        where: { id: { in: [own.id, bobShot.id] } },
      });
      check("no row was deleted by any of it", survivors === 2, `${survivors} of 2 left`);
    }

    // -----------------------------------------------------------------------
    section("9. Signed out reaches nothing");
    // -----------------------------------------------------------------------
    {
      const target = aliceShots[0]!;

      const list = await get(MINE);
      const image = await get(`${MINE}/${target.id}/image`);
      const key = await get(`${MINE}/${encodeURIComponent(target.storageKey)}/image`);

      check("the list is a 401", list.status === 401, `status ${list.status}`);
      check("the image is a 401", image.status === 401, `status ${image.status}`);
      check(
        "a storage key signed out is still a 401, not a 404 that read the disk",
        key.status === 401,
        `status ${key.status}`,
      );
      check("no image bytes came back", !image.raw.startsWith("�"));

      // A stale or invented cookie is not a session.
      const forged = `${SESSION_COOKIE}=${randomBytes(32).toString("base64url")}`;
      const withJunk = await get(MINE, forged);
      check(
        "an invented session token is a 401",
        withJunk.status === 401,
        `status ${withJunk.status}`,
      );
    }

    // -----------------------------------------------------------------------
    section("10. The administrator keeps everything they had");
    // -----------------------------------------------------------------------
    {
      const own = aliceShots[3]!;

      const list = await get(`/api/screenshots?agent=${alice.id}`, adminCookie);
      check("GET /api/screenshots is 200 for an admin", list.status === 200, `status ${list.status}`);
      check(
        "and it can still be filtered to an agent",
        Array.isArray(list.body.screenshots) &&
          (list.body.screenshots as ListRow[]).length > 0,
      );

      const card = await get(`/api/screenshots/${own.id}`, adminCookie);
      check("GET /api/screenshots/:id is 200 for an admin", card.status === 200, `status ${card.status}`);

      const image = await fetch(`${BASE_URL}/api/screenshots/${own.id}/image`, {
        headers: { cookie: adminCookie },
      });
      check(
        "an admin can still stream any agent's image",
        image.status === 200,
        `status ${image.status}`,
      );
      await image.arrayBuffer();

      // The agent endpoint is open to an administrator too, and returns their
      // own captures — of which they have none. Not a 403: it is the same "your
      // own figures" rule `/api/performance/me` follows.
      const adminOwn = await get(MINE, adminCookie);
      check(
        "an admin calling the agent endpoint gets their own list",
        adminOwn.status === 200,
        `status ${adminOwn.status}`,
      );
      check("which is empty, because they have no captures", rowsOf(adminOwn).length === 0);

      const removed = await send("DELETE", `/api/admin/screenshots/${doomed.id}`, adminCookie);
      check(
        "an admin can still delete a screenshot",
        removed.status === 200,
        `status ${removed.status}`,
      );
      check(
        "and the row is actually gone",
        (await prisma.screenshot.count({ where: { id: doomed.id } })) === 0,
      );

      const afterwards = await get(`${MINE}?limit=${MY_SCREENSHOT_MAX_PAGE_SIZE}`, aliceCookie);
      check(
        "the agent's own list reflects the deletion",
        rowsOf(afterwards).every((row) => row.id !== doomed.id),
      );
    }
  } finally {
    // ---------------------------------------------------------------------
    // Teardown. Runs after a failure too — a test that leaves users, shifts
    // and image files behind is a test nobody runs twice.
    // ---------------------------------------------------------------------
    const ids = [admin.id, alice.id, bob.id];

    await prisma.screenshot.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.activityInterval.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
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
