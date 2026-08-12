import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import { newStorageKey, putScreenshot, storageRoot } from "../lib/screenshotStorage";

/**
 * End-to-end check of admin screenshot deletion, against a running server and a
 * real database.
 *
 *   npm run dev                     (in one terminal)
 *   npm run test:screenshot-delete  (in another)
 *
 * The sibling of `test-screenshot-viewer.ts`, written the same way and for the
 * same reason: none of the claims worth checking here are unit-testable in any
 * useful sense. "An agent gets a 403 from the bulk delete" is a claim about a
 * cookie, a session row, a role column and an HTTP handler, and "the file is
 * gone" is a claim about a disk. So this speaks HTTP to the real routes with
 * real session cookies, and then looks at Postgres and the filesystem itself.
 *
 * It creates a throwaway administrator and a throwaway agent (`deltest-*`),
 * their shifts, their sessions and a set of screenshots with real files on disk
 * — and deletes all of it on the way out, including after a failure. It never
 * touches an existing user, shift, session or screenshot, and it never runs the
 * retention sweep, which is global and is not this feature's to exercise.
 *
 * The two canary files it plants are the point of the traversal section: they
 * sit where a successful escape would land, and every check that matters ends
 * with "and the canary is still there".
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "delete-test-Pa55phrase";

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

/** A minimal JPEG whose SOF0 states the dimensions. Same trick as the viewer's. */
function fakeJpeg(width: number, height: number, padding = 1024): Uint8Array {
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
      userAgent: "screenshot-delete-test",
      ipAddress: "127.0.0.1",
    },
  });

  return `${SESSION_COOKIE}=${token}`;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function request(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: "manual",
  });

  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }

  return { status: response.status, body, raw };
}

const del = (url: string, cookie?: string, body?: unknown) =>
  request("DELETE", url, { cookie, body });
const get = (url: string, cookie?: string) => request("GET", url, { cookie });

async function exists(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

/** Local midnight plus a time of day, as an instant. */
function at(hours: number, minutes: number, dayOffset = 0): Date {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
}

interface Fixture {
  id: string;
  storageKey: string;
  absolutePath: string;
}

async function main(): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const root = storageRoot();
  const storageKeys: string[] = [];

  console.log(`\nAdmin screenshot deletion — ${BASE_URL}\n`);

  const [admin, agent] = await Promise.all(
    (
      [
        ["deladmin", "Delete Test Admin", "ADMIN"],
        ["delagent", "Delete Test Agent", "AGENT"],
      ] as const
    ).map(async ([stem, name, role]) =>
      prisma.user.create({
        data: {
          username: `deltest-${stem}-${suffix}`,
          email: `deltest-${stem}-${suffix}@example.invalid`,
          name: `${name} ${suffix}`,
          passwordHash: await hashPassword(PASSWORD),
          role,
          isActive: true,
        },
        select: { id: true, name: true },
      }),
    ),
  );

  /*
   * The canaries. One inside the storage root and one beside it, at exactly the
   * two places a successful traversal would land. Nothing under test is
   * supposed to be able to name either, and every escape attempt below ends by
   * confirming they are both still there.
   */
  const canaryInside = path.resolve(root, "deltest-canary-inside.txt");
  const canaryOutside = path.resolve(root, "..", `deltest-canary-outside-${suffix}.txt`);

  try {
    await mkdir(root, { recursive: true });
    await writeFile(canaryInside, "do not delete");
    await writeFile(canaryOutside, "do not delete");

    const shift = await prisma.workSession.create({
      data: {
        userId: agent.id,
        startedAt: at(9, 0),
        lastSeenAt: at(17, 0),
        endedAt: at(17, 0),
        durationSeconds: 28_800,
      },
      select: { id: true },
    });

    /** Make a screenshot row with a real file behind it. */
    async function makeScreenshot(capturedAt: Date): Promise<Fixture> {
      const bytes = fakeJpeg(1920, 1080);
      const key = newStorageKey("image/jpeg", agent.id, capturedAt);
      const size = await putScreenshot(key, bytes);
      storageKeys.push(key);

      const row = await prisma.screenshot.create({
        data: {
          userId: agent.id,
          workSessionId: shift.id,
          capturedAt,
          storageKey: key,
          width: 1920,
          height: 1080,
          fileSize: size,
          format: "image/jpeg",
          displayId: "2528732444",
        },
        select: { id: true },
      });

      return { id: row.id, storageKey: key, absolutePath: path.resolve(root, key) };
    }

    // Twelve today: one for the individual delete, one for the refusals, three
    // for a clean bulk, two for a partial bulk, and the rest as bystanders that
    // must still be there at the end.
    const shots: Fixture[] = [];
    for (let index = 0; index < 12; index += 1) {
      shots.push(await makeScreenshot(at(9, 5 + index * 5)));
    }

    const adminCookie = await signIn(admin.id);
    const agentCookie = await signIn(agent.id);

    // -----------------------------------------------------------------------
    console.log("A signed-out caller cannot delete anything");
    // -----------------------------------------------------------------------
    {
      const one = await del(`/api/admin/screenshots/${shots[0]!.id}`);
      check("the individual delete answers 401 with no session", one.status === 401, `status ${one.status}`);

      const many = await del("/api/admin/screenshots", undefined, {
        ids: [shots[0]!.id, shots[1]!.id],
      });
      check("the bulk delete answers 401 with no session", many.status === 401, `status ${many.status}`);

      check(
        "nothing was deleted by an unauthenticated caller",
        (await prisma.screenshot.count({ where: { id: { in: [shots[0]!.id, shots[1]!.id] } } })) === 2 &&
          (await exists(shots[0]!.absolutePath)),
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nAn authenticated AGENT cannot delete anything either");
    // -----------------------------------------------------------------------
    {
      const one = await del(`/api/admin/screenshots/${shots[0]!.id}`, agentCookie);
      check("the individual delete answers 403 for an agent", one.status === 403, `status ${one.status}`);

      const many = await del("/api/admin/screenshots", agentCookie, {
        ids: shots.map((shot) => shot.id),
      });
      check("the bulk delete answers 403 for an agent", many.status === 403, `status ${many.status}`);

      // The subject of the screenshots is the agent themselves. This is the
      // check that separates "screenshots are private to their subject" from
      // "screenshots are for administrators", and it is the latter.
      check(
        "an agent cannot delete their own screenshots",
        (await prisma.screenshot.count({ where: { userId: agent.id } })) === shots.length,
      );
      check("their files are all still on disk", await exists(shots[0]!.absolutePath));
    }

    // -----------------------------------------------------------------------
    console.log("\nAn ADMIN deletes one screenshot");
    // -----------------------------------------------------------------------
    const victim = shots[0]!;
    {
      check("its file exists before the delete", await exists(victim.absolutePath));

      const reply = await del(`/api/admin/screenshots/${victim.id}`, adminCookie);
      check("the delete answers 200", reply.status === 200, `status ${reply.status}`);
      check("the response names the screenshot", reply.body.id === victim.id);

      check("its file is gone from disk", !(await exists(victim.absolutePath)));
      check(
        "its row is gone from Postgres",
        (await prisma.screenshot.findUnique({ where: { id: victim.id } })) === null,
      );
      check(
        "no other screenshot was touched",
        (await prisma.screenshot.count({ where: { userId: agent.id } })) === shots.length - 1,
      );
      check("a bystander's file is untouched", await exists(shots[1]!.absolutePath));
    }

    {
      // Deleting it a second time. The row is gone, so this is a 404 — and it
      // must not be a 200 that pretends to have deleted something.
      const again = await del(`/api/admin/screenshots/${victim.id}`, adminCookie);
      check("deleting it again is a 404", again.status === 404, `status ${again.status}`);
    }

    {
      // The viewer agrees: the metadata route no longer knows the row either.
      const gone = await get(`/api/screenshots/${victim.id}`, adminCookie);
      check("the viewer reports it as gone", gone.status === 404, `status ${gone.status}`);
    }

    // -----------------------------------------------------------------------
    console.log("\nAn ADMIN deletes a batch");
    // -----------------------------------------------------------------------
    const batch = [shots[1]!, shots[2]!, shots[3]!];
    {
      const reply = await del("/api/admin/screenshots", adminCookie, {
        ids: batch.map((shot) => shot.id),
      });
      check("the bulk delete answers 200", reply.status === 200, `status ${reply.status}`);

      const deleted = (reply.body.deleted as string[] | undefined) ?? [];
      const failures = (reply.body.failed as unknown[] | undefined) ?? [];

      check("all three are reported deleted", deleted.length === 3, `${deleted.length}`);
      check("nothing is reported failed", failures.length === 0, `${failures.length}`);
      check("the request count is echoed back", reply.body.requested === 3);

      const stillOnDisk: string[] = [];
      for (const shot of batch) if (await exists(shot.absolutePath)) stillOnDisk.push(shot.id);
      check("all three files are gone from disk", stillOnDisk.length === 0, stillOnDisk.join(", "));

      check(
        "all three rows are gone from Postgres",
        (await prisma.screenshot.count({ where: { id: { in: batch.map((s) => s.id) } } })) === 0,
      );
      check(
        "the bystanders are all still there",
        (await prisma.screenshot.count({ where: { userId: agent.id } })) === shots.length - 4,
      );
    }

    {
      // A duplicate id must not be reported twice, and must not produce a
      // phantom "already gone" failure alongside its own success.
      const reply = await del("/api/admin/screenshots", adminCookie, {
        ids: [shots[4]!.id, shots[4]!.id],
      });
      const deleted = (reply.body.deleted as string[] | undefined) ?? [];
      const failures = (reply.body.failed as unknown[] | undefined) ?? [];
      check(
        "a duplicated id is collapsed into one outcome",
        reply.status === 200 && deleted.length === 1 && failures.length === 0,
        `${deleted.length} deleted, ${failures.length} failed`,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nPartial failures are reported, never rounded up");
    // -----------------------------------------------------------------------
    {
      const real = shots[5]!;
      const reply = await del("/api/admin/screenshots", adminCookie, {
        // One real id, one that never existed, one that is not the shape of an
        // id at all. The real one must still go.
        ids: [real.id, "clnotarealidatall000000", "../../etc/passwd"],
      });

      check("the mixed batch still answers 200", reply.status === 200, `status ${reply.status}`);

      const deleted = (reply.body.deleted as string[] | undefined) ?? [];
      const failures =
        (reply.body.failed as Array<{ id: string; reason: string }> | undefined) ?? [];

      check("the valid screenshot was deleted", deleted.length === 1 && deleted[0] === real.id);
      check("its file is gone", !(await exists(real.absolutePath)));
      check("the two bad ids are reported as failures", failures.length === 2, `${failures.length}`);
      check(
        "the unknown id is reported as not_found",
        failures.some((row) => row.id === "clnotarealidatall000000" && row.reason === "not_found"),
      );
      check(
        "the path-shaped id is reported as invalid_id",
        failures.some((row) => row.reason === "invalid_id"),
      );
      check("every failure carries a reason for the UI", failures.every((row) => Boolean(row.reason)));
    }

    // -----------------------------------------------------------------------
    console.log("\nThe client cannot name a file");
    // -----------------------------------------------------------------------
    {
      const attempts = [
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "....//....//package.json",
        encodeURIComponent("../../../../.env"),
        encodeURIComponent("deltest-canary-inside.txt"),
        encodeURIComponent(storageKeys[6]!),
        encodeURIComponent(path.resolve(root, storageKeys[6]!)),
        encodeURIComponent(canaryOutside),
      ];

      for (const attempt of attempts) {
        const reply = await del(`/api/admin/screenshots/${attempt}`, adminCookie);
        check(
          `individual traversal refused: ${decodeURIComponent(attempt).slice(0, 42)}`,
          // Not `=== 404`. Most of these are a 404 from the handler, but a
          // path containing `//` never reaches it: Next normalises the URL and
          // answers 308 first. Both are refusals, and the claim under test is
          // that none of them deletes anything — which the canary checks below
          // are what actually establish.
          reply.status !== 200,
          `status ${reply.status}`,
        );
      }

      const bulk = await del("/api/admin/screenshots", adminCookie, {
        ids: attempts.map((attempt) => decodeURIComponent(attempt)),
      });
      const bulkDeleted = (bulk.body.deleted as string[] | undefined) ?? [];
      check(
        "bulk traversal deletes nothing",
        bulk.status === 400 || bulkDeleted.length === 0,
        `status ${bulk.status}, ${bulkDeleted.length} deleted`,
      );

      check("the canary inside the storage root survives", await exists(canaryInside));
      check("the canary outside the storage root survives", await exists(canaryOutside));
      check("the screenshot named by its storage key survives", await exists(shots[6]!.absolutePath));
      check(
        "no row was deleted by any traversal attempt",
        (await prisma.screenshot.count({ where: { id: shots[6]!.id } })) === 1,
      );
    }

    {
      // And the same attempt signed out, which must never get further than the
      // guard — a 404 here would mean the handler had already looked at a disk.
      const reply = await del("/api/admin/screenshots/..%2F..%2F.env");
      check(
        "traversal signed out is a 401, not a 404 that touched anything",
        reply.status === 401,
        `status ${reply.status}`,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nMalformed bulk requests are refused");
    // -----------------------------------------------------------------------
    {
      const cases: Array<[string, unknown]> = [
        ["an empty list", { ids: [] }],
        ["a missing list", {}],
        ["a string instead of a list", { ids: "abc" }],
        ["a list of non-strings", { ids: [1, null, {}] }],
        ["more than the cap", { ids: Array.from({ length: 501 }, (_, i) => `id${i}`) }],
      ];

      for (const [label, body] of cases) {
        const reply = await del("/api/admin/screenshots", adminCookie, body);
        check(`${label} is a 400`, reply.status === 400, `status ${reply.status}`);
      }

      const bad = await fetch(`${BASE_URL}/api/admin/screenshots`, {
        method: "DELETE",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: "not json at all",
      });
      check("a body that is not JSON is a 400", bad.status === 400, `status ${bad.status}`);
    }

    // -----------------------------------------------------------------------
    console.log("\nThe controls are drawn for an admin and for nobody else");
    // -----------------------------------------------------------------------
    {
      // The panel is server-rendered for the default filter, so the delete
      // affordances are in the markup rather than only in a bundle — which is
      // what makes this checkable without a browser.
      const adminPage = await get("/screenshots", adminCookie);
      check(
        "the admin page renders the select-all control",
        adminPage.status === 200 && adminPage.raw.includes("Select all on this page"),
        `status ${adminPage.status}`,
      );
      check(
        "the admin page renders a per-screenshot delete action",
        adminPage.raw.includes("Delete screenshot"),
      );

      const agentPage = await get("/screenshots", agentCookie);
      check(
        "an agent is shown no delete controls at all",
        !agentPage.raw.includes("Select all on this page") &&
          !agentPage.raw.includes("Delete screenshot") &&
          !agentPage.raw.includes("Delete Selected"),
        `status ${agentPage.status}`,
      );
    }

    // -----------------------------------------------------------------------
    console.log("\nThe rest of the viewer is unaffected");
    // -----------------------------------------------------------------------
    {
      // Six have been deleted by this point: one individually, three in a
      // batch, one through the duplicate case and one in the mixed batch.
      const DELETED_SO_FAR = 6;
      const removed = shots.slice(0, DELETED_SO_FAR);
      const remaining = shots.slice(DELETED_SO_FAR);

      const list = await get(`/api/screenshots?agent=${agent.id}`, adminCookie);
      const rows = (list.body.screenshots as Array<{ id: string }> | undefined) ?? [];

      check("the list still answers 200", list.status === 200, `status ${list.status}`);
      check(
        "the filter returns exactly the surviving screenshots",
        rows.length === remaining.length &&
          remaining.every((shot) => rows.some((row) => row.id === shot.id)),
        `${rows.length} rows, expected ${remaining.length}`,
      );
      check(
        "no deleted screenshot reappears",
        !rows.some((row) => removed.some((shot) => shot.id === row.id)),
      );
      check(
        "every deleted row is gone from Postgres",
        (await prisma.screenshot.count({
          where: { id: { in: removed.map((shot) => shot.id) } },
        })) === 0,
      );
      check("no storage key leaks into the list", !list.raw.includes("storageKey"));

      const image = await get(`/api/screenshots/${remaining[0]!.id}/image`, adminCookie);
      check(
        "a surviving screenshot's image still streams",
        image.status === 200,
        `status ${image.status}`,
      );

      // Retention's own view of the world: the rows this feature left behind are
      // still ordinary rows with a `created_at` and a storage key, which is
      // everything the sweep needs. Nothing about them was changed by deleting
      // their neighbours.
      const survivor = await prisma.screenshot.findUnique({
        where: { id: remaining[0]!.id },
        select: { createdAt: true, storageKey: true },
      });
      check(
        "surviving rows are still exactly what the retention sweep expects",
        Boolean(survivor?.createdAt) &&
          survivor?.storageKey === remaining[0]!.storageKey &&
          (await exists(remaining[0]!.absolutePath)),
      );

      /*
       * And the sweep itself still runs. Called with a clock set decades back,
       * so its cutoff precedes every row in the database and it deletes
       * nothing — this checks that manual deletion has not broken the module,
       * without letting a test issue a real, global, destructive sweep against
       * whatever database it happens to be pointed at.
       */
      const { runScreenshotRetention } = await import("../lib/screenshotRetention");
      const sweep = await runScreenshotRetention({ now: new Date("2000-01-01T00:00:00Z") });
      check(
        "the retention sweep still runs and still deletes only what it should",
        sweep.examined === 0 && sweep.rowsDeleted === 0 && sweep.failed === 0,
        `examined ${sweep.examined}, rows ${sweep.rowsDeleted}, failed ${sweep.failed}`,
      );
      check(
        "the sweep left every surviving screenshot alone",
        (await prisma.screenshot.count({ where: { userId: agent.id } })) === remaining.length,
      );
    }
  } finally {
    // ---------------------------------------------------------------------
    // Teardown. Runs after a failure too — a test that leaves users, shifts
    // and image files behind is a test nobody runs twice.
    // ---------------------------------------------------------------------
    const ids = [admin.id, agent.id];

    await prisma.screenshot.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.workSession.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});

    for (const key of storageKeys) {
      await rm(path.resolve(root, key), { force: true }).catch(() => {});
    }
    await rm(canaryInside, { force: true }).catch(() => {});
    await rm(canaryOutside, { force: true }).catch(() => {});

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
