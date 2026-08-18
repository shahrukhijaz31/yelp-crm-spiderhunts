import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import { newStorageKey, putScreenshot, storageRoot } from "../lib/screenshotStorage";
import {
  DEFAULT_MY_SCREENSHOT_PAGE_SIZE,
  MY_SCREENSHOT_PAGE_SIZES,
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
 * adding a `userId`, by passing another agent's work session to the filter, by
 * asking for a storage key, by calling the admin API, or by trying to delete
 * anything at all. Every one of those is below, and every one of them must
 * fail.
 *
 * The second half of the file is the filters and the pager. Those are not
 * security claims but they are the ones most likely to break quietly: a filter
 * that is silently ignored looks exactly like a filter that matched everything,
 * and a pager that double-counts looks exactly like a busy day. So every filter
 * is checked against a count computed from the fixture rather than against
 * itself, and the pages are walked and compared to the unpaged read.
 *
 * It creates a throwaway administrator and two throwaway agents (`mysstest-*`),
 * their shifts, their sessions, an activity interval and thirty-odd screenshots
 * with real files on disk — and deletes all of it on the way out, including
 * after a failure. It never touches an existing user, shift, session or
 * screenshot, and the only delete it performs is against a screenshot it
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

/** Big enough to hold the whole fixture on one page. */
const ALL_ON_ONE_PAGE = MY_SCREENSHOT_PAGE_SIZES[MY_SCREENSHOT_PAGE_SIZES.length - 1];

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

interface Meta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function rowsOf(reply: Reply): ListRow[] {
  return (reply.body.screenshots as ListRow[] | undefined) ?? [];
}

function metaOf(reply: Reply): Meta {
  return (reply.body.meta as Meta | undefined) ?? {
    page: 0,
    pageSize: 0,
    total: -1,
    totalPages: -1,
  };
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
    const [aliceToday, aliceYesterday, bobShift] = await Promise.all([
      prisma.workSession.create({
        data: {
          userId: alice.id,
          startedAt: at(9, 0),
          lastSeenAt: at(18, 30),
          endedAt: at(18, 30),
          durationSeconds: 34_200,
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
     * The fixture.
     *
     * Alice gets twenty-eight captures today at ten-minute intervals from 09:00,
     * three yesterday, and Bob two — deliberately unequal, and deliberately more
     * than one page. A scoping bug that returned everybody's rows would be
     * invisible against a fixture where both agents have the same number, and a
     * pager that silently returned everything would be invisible against one
     * that fits on a single page.
     */
    const aliceTodayTimes = Array.from({ length: 28 }, (_, index) =>
      at(9 + Math.floor((index * 10) / 60), (index * 10) % 60),
    );
    const aliceYesterdayTimes = [at(9, 0, -1), at(12, 0, -1), at(15, 0, -1)];
    const bobTimes = [at(10, 15), at(15, 40)];

    const fixtures = [
      ...aliceTodayTimes.map((capturedAt) => ({
        owner: alice,
        shift: aliceToday.id,
        capturedAt,
      })),
      ...aliceYesterdayTimes.map((capturedAt) => ({
        owner: alice,
        shift: aliceYesterday.id,
        capturedAt,
      })),
      ...bobTimes.map((capturedAt) => ({
        owner: bob,
        shift: bobShift.id,
        capturedAt,
      })),
    ];

    const created: Array<{
      id: string;
      userId: string;
      storageKey: string;
      capturedAt: Date;
    }> = [];

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
     * One activity interval covering Alice's second capture, so the metadata the
     * card shows is checked against a row that exists rather than only against
     * the nulls an empty table would produce.
     */
    await prisma.activityInterval.create({
      data: {
        userId: alice.id,
        workSessionId: aliceToday.id,
        startedAt: aliceTodayTimes[1]!,
        endedAt: new Date(aliceTodayTimes[1]!.getTime() + 60_000),
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
        workSessionId: aliceToday.id,
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

    // A real capture of Alice's, created only so the administrator can delete
    // something at the end without touching anything else under test.
    const doomedKey = newStorageKey("image/jpeg", alice.id, at(18, 0));
    const doomedSize = await putScreenshot(doomedKey, fakeJpeg(1280, 720));
    storageKeys.push(doomedKey);
    const doomed = await prisma.screenshot.create({
      data: {
        userId: alice.id,
        workSessionId: aliceToday.id,
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

    /* What each filter should be able to reach, computed from the fixture. */
    const expect = {
      // + the orphan row and the doomed one, both Alice's and both today
      all: aliceShots.length + 2,
      today: aliceTodayTimes.length + 2,
      yesterday: aliceYesterdayTimes.length,
      todaySession: aliceTodayTimes.length + 2,
      yesterdaySession: aliceYesterdayTimes.length,
      // [09:00, 10:00) over today's captures: 09:00 .. 09:50
      morningWindow: aliceTodayTimes.filter(
        (time) => time.getHours() === 9,
      ).length,
    };

    const adminCookie = await signIn(admin.id);
    const aliceCookie = await signIn(alice.id);
    const bobCookie = await signIn(bob.id);

    // -----------------------------------------------------------------------
    section("1. An agent can list their own screenshots");
    // -----------------------------------------------------------------------
    {
      const reply = await get(`${MINE}?pageSize=${ALL_ON_ONE_PAGE}`, aliceCookie);
      const rows = rowsOf(reply);
      const ids = new Set(rows.map((row) => row.id));

      check("the list answers 200", reply.status === 200, `status ${reply.status}`);
      check(
        "it returns every one of this agent's captures",
        rows.length === expect.all,
        `${rows.length} rows, expected ${expect.all}`,
      );
      check(
        "the total agrees with the rows",
        metaOf(reply).total === expect.all,
        `total ${metaOf(reply).total}`,
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
      const reply = await get(`${MINE}?pageSize=${ALL_ON_ONE_PAGE}`, aliceCookie);

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
          (row) => typeof row.capturedAt === "string" && "activityPercentage" in row,
        ),
      );
      check(
        "the activity figure recorded for one capture came through",
        rowsOf(reply).some((row) => row.activityPercentage === 67),
      );

      // The shift picker travels with the page. It must list this agent's own
      // shifts and no one else's — an id in it is an id the client may send back.
      const sessions = (reply.body.sessions as Array<{ id: string }>) ?? [];
      check(
        "the work session picker lists only this agent's shifts",
        sessions.length > 0 && sessions.every((session) => session.id !== bobShift.id),
        `${sessions.length} sessions`,
      );
    }

    // -----------------------------------------------------------------------
    section("3. Pagination — a page at a time, and never the whole table");
    // -----------------------------------------------------------------------
    {
      const first = await get(`${MINE}?pageSize=24`, aliceCookie);
      const firstMeta = metaOf(first);

      check("a page size of 24 returns 24 rows", rowsOf(first).length === 24);
      check("the page number is reported", firstMeta.page === 1);
      check(
        "the total counts every matching row, not the page",
        firstMeta.total === expect.all,
        `${firstMeta.total}`,
      );
      check(
        "the page count follows from the total",
        firstMeta.totalPages === Math.ceil(expect.all / 24),
        `${firstMeta.totalPages}`,
      );

      const second = await get(`${MINE}?pageSize=24&page=2`, aliceCookie);
      const firstIds = new Set(rowsOf(first).map((row) => row.id));
      const secondIds = rowsOf(second).map((row) => row.id);

      check(
        "the second page holds the remainder",
        secondIds.length === expect.all - 24,
        `${secondIds.length}`,
      );
      check(
        "with no overlap against the first",
        secondIds.every((id) => !firstIds.has(id)),
      );
      check(
        "and none of them the other agent's",
        secondIds.every((id) => !bobShots.some((shot) => shot.id === id)),
      );

      // Walk every page and compare to the unpaged read. A skip/take that
      // double-counted or dropped a row lands here and nowhere else.
      const walked = new Set<string>();
      for (let page = 1; page <= firstMeta.totalPages; page += 1) {
        const reply = await get(`${MINE}?pageSize=24&page=${page}`, aliceCookie);
        for (const row of rowsOf(reply)) walked.add(row.id);
      }
      check(
        "walking the pages visits every row exactly once",
        walked.size === expect.all,
        `${walked.size} of ${expect.all}`,
      );

      const past = await get(`${MINE}?pageSize=24&page=99`, aliceCookie);
      check(
        "a page past the end is an empty page, not an error",
        past.status === 200 && rowsOf(past).length === 0,
        `status ${past.status}`,
      );
      check(
        "and it still reports the real total",
        metaOf(past).total === expect.all,
        `${metaOf(past).total}`,
      );

      const huge = await get(`${MINE}?pageSize=100000`, aliceCookie);
      check(
        "a page size that is not on the menu falls back to the default",
        metaOf(huge).pageSize === DEFAULT_MY_SCREENSHOT_PAGE_SIZE,
        `pageSize ${metaOf(huge).pageSize}`,
      );
      check(
        "so it cannot be used to fetch everything at once",
        rowsOf(huge).length <= DEFAULT_MY_SCREENSHOT_PAGE_SIZE,
        `${rowsOf(huge).length} rows`,
      );

      const junk = await get(`${MINE}?pageSize=-5&page=abc&date=wat`, aliceCookie);
      check(
        "nonsense parameters are clamped rather than rejected",
        junk.status === 200 && metaOf(junk).page === 1 && rowsOf(junk).length > 0,
        `status ${junk.status}`,
      );
    }

    // -----------------------------------------------------------------------
    section("4. The filters actually filter");
    // -----------------------------------------------------------------------
    {
      const cases: Array<[string, string, number]> = [
        ["all dates is the default", `pageSize=${ALL_ON_ONE_PAGE}`, expect.all],
        ["date=today", `date=today&pageSize=${ALL_ON_ONE_PAGE}`, expect.today],
        ["date=yesterday", `date=yesterday&pageSize=${ALL_ON_ONE_PAGE}`, expect.yesterday],
        [
          "date=custom on yesterday's day",
          `date=custom&day=${isoDay(at(0, 0, -1))}&pageSize=${ALL_ON_ONE_PAGE}`,
          expect.yesterday,
        ],
        [
          "a time window inside today",
          `date=today&from=09:00&to=10:00&pageSize=${ALL_ON_ONE_PAGE}`,
          expect.morningWindow,
        ],
        [
          "a reversed time window is read the right way round",
          `date=today&from=10:00&to=09:00&pageSize=${ALL_ON_ONE_PAGE}`,
          expect.morningWindow,
        ],
        [
          "session = today's shift",
          `session=${aliceToday.id}&pageSize=${ALL_ON_ONE_PAGE}`,
          expect.todaySession,
        ],
        [
          "session = yesterday's shift",
          `session=${aliceYesterday.id}&pageSize=${ALL_ON_ONE_PAGE}`,
          expect.yesterdaySession,
        ],
        [
          "session and date together narrow further",
          `date=yesterday&session=${aliceToday.id}&pageSize=${ALL_ON_ONE_PAGE}`,
          0,
        ],
        [
          "a day with nothing on it",
          `date=custom&day=1999-01-01&pageSize=${ALL_ON_ONE_PAGE}`,
          0,
        ],
      ];

      for (const [label, params, expected] of cases) {
        const reply = await get(`${MINE}?${params}`, aliceCookie);
        const meta = metaOf(reply);
        check(
          `${label} → ${expected}`,
          reply.status === 200 &&
            rowsOf(reply).length === expected &&
            meta.total === expected,
          `${rowsOf(reply).length} rows, total ${meta.total}`,
        );
      }

      // A time of day cannot mean anything across an unbounded range of days,
      // so it is dropped rather than silently applied to one of them.
      const acrossAll = await get(
        `${MINE}?from=09:00&to=10:00&pageSize=${ALL_ON_ONE_PAGE}`,
        aliceCookie,
      );
      check(
        "a time filter with no date selected is ignored, not half-applied",
        metaOf(acrossAll).total === expect.all,
        `total ${metaOf(acrossAll).total}`,
      );
    }

    // -----------------------------------------------------------------------
    section("5. An agent can view their own image, and it is served safely");
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

      // A link to a capture must keep working whatever the gallery behind it is
      // filtered to — the image route is asked for one row, not for a view.
      const filtered = await get(
        `${MINE}/${target.id}/image?date=custom&day=1999-01-01&session=${bobShift.id}`,
        aliceCookie,
      );
      check(
        "filters on the image URL neither grant nor deny anything",
        filtered.status === 200,
        `status ${filtered.status}`,
      );
    }

    // -----------------------------------------------------------------------
    section("6. IDOR — another agent's screenshot, by every route in");
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
    section("7. Nothing in the request can change whose list it is");
    // -----------------------------------------------------------------------
    {
      const baseline = rowsOf(await get(`${MINE}?pageSize=${ALL_ON_ONE_PAGE}`, aliceCookie))
        .map((row) => row.id)
        .sort();

      const attempts = [
        `userId=${bob.id}`,
        `agent=${bob.id}`,
        `agentId=${bob.id}`,
        `user=${bob.id}`,
        `userId=${bob.id}&agent=${bob.id}&agentId=${bob.id}`,
      ];

      for (const attempt of attempts) {
        const reply = await get(
          `${MINE}?pageSize=${ALL_ON_ONE_PAGE}&${attempt}`,
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

      /*
       * The work session filter is the one id a client legitimately supplies, so
       * it gets its own checks: another agent's shift must narrow to nothing
       * rather than widen to them, and it must not be able to reach their rows
       * from either direction.
       */
      const foreign = await get(
        `${MINE}?pageSize=${ALL_ON_ONE_PAGE}&session=${bobShift.id}`,
        aliceCookie,
      );
      check(
        "another agent's work session returns an empty page, not their gallery",
        foreign.status === 200 &&
          rowsOf(foreign).length === 0 &&
          metaOf(foreign).total === 0,
        `${rowsOf(foreign).length} rows, total ${metaOf(foreign).total}`,
      );
      check(
        "and it leaks nothing about them",
        !foreign.raw.includes(bob.id) && !foreign.raw.includes(bob.name),
      );

      const mirrored = await get(
        `${MINE}?pageSize=${ALL_ON_ONE_PAGE}&session=${aliceToday.id}`,
        bobCookie,
      );
      check(
        "and the same in reverse — Alice's shift returns nothing to Bob",
        mirrored.status === 200 && rowsOf(mirrored).length === 0,
        `${rowsOf(mirrored).length} rows`,
      );

      const nonsenseSession = await get(
        `${MINE}?pageSize=${ALL_ON_ONE_PAGE}&session=../../etc/passwd`,
        aliceCookie,
      );
      check(
        "a malformed session id is dropped, not passed on",
        nonsenseSession.status === 200 &&
          rowsOf(nonsenseSession).length === baseline.length,
        `status ${nonsenseSession.status}, ${rowsOf(nonsenseSession).length} rows`,
      );
    }

    // -----------------------------------------------------------------------
    section("8. The agent endpoints are read-only");
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
    section("9. The admin screenshot API is unreachable from an agent session");
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
    section("10. Signed out reaches nothing");
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

      const forged = `${SESSION_COOKIE}=${randomBytes(32).toString("base64url")}`;
      const withJunk = await get(MINE, forged);
      check(
        "an invented session token is a 401",
        withJunk.status === 401,
        `status ${withJunk.status}`,
      );
    }

    // -----------------------------------------------------------------------
    section("11. The administrator keeps everything they had");
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

      const afterwards = await get(`${MINE}?pageSize=${ALL_ON_ONE_PAGE}`, aliceCookie);
      check(
        "the agent's own list reflects the deletion",
        rowsOf(afterwards).every((row) => row.id !== doomed.id) &&
          metaOf(afterwards).total === expect.all - 1,
        `total ${metaOf(afterwards).total}`,
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
