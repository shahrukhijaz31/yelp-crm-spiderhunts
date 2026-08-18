import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { demoImageRoot } from "../lib/demoImageStorage";
import { sniffDemoImage } from "../lib/demoImageRules";
import {
  DemoWebsiteError,
  normaliseDemoUrl,
  DEMO_PAGE_SIZES,
} from "../lib/demoWebsiteRules";
import { DEFAULT_MODULE_ACCESS } from "../lib/modules";
import { hashPassword } from "../lib/password";

/**
 * The Demo Websites module, end to end.
 *
 *   npm run dev              (in one terminal)
 *   npm run test:demo-websites   (in another)
 *
 * Written for the reason `test-agent-screenshots.ts` gives: every claim worth
 * checking here is a claim about a cookie, a session row, a role column, a
 * module column, a `where` clause and an HTTP status. A mocked version of any
 * of them would pass whether or not the real thing works, so this speaks HTTP
 * to the real routes with real session cookies and checks what actually comes
 * back.
 *
 * The question it exists to answer is not "does the list load". It is whether
 * an agent holding a valid session and a text editor can reach or change one
 * byte they should not: by typing the URL, by changing an id, by adding a
 * `userId` to a body, by claiming a role, by supplying a storage key, by
 * calling a write verb, or by asking for an image they have no module for.
 * Every one of those is below, and every one of them must fail.
 *
 * It also checks the two claims the brief cares most about and that no unit
 * test can make: that Demo Websites are stored **separately** from leads, and
 * that adding the module changed nothing about leads, recordings or meetings.
 *
 * ---------------------------------------------------------------------------
 * What it creates, and what it never touches
 * ---------------------------------------------------------------------------
 * Four throwaway accounts (`dwtest-*`) — an administrator and three agents with
 * three different module grants — their sessions, and a handful of demo
 * websites with real image files on disk. All of it is deleted on the way out,
 * including after a failure. It never creates, edits or deletes a lead, a
 * recording, a meeting or a real user; the lead-side checks are counts taken
 * before and after and compared.
 *
 * Sessions are inserted directly rather than signed in for: a real portal
 * sign-in needs a six-digit code delivered by email, which a test cannot read.
 * The token construction is copied from `lib/session.ts`, so what the routes
 * authenticate is exactly what they authenticate in production.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "demo-websites-test-Pa55phrase";
const origin = new URL(BASE_URL).origin;

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

const API = "/api/demo-websites";

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

// --- fixtures ----------------------------------------------------------------

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

  return new Uint8Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.length));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A genuinely valid greyscale PNG, not a header with padding after it.
 *
 * A real file rather than a plausible one, because "the sniffer accepts a PNG"
 * is only worth checking against something a viewer would actually open.
 */
function realPng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // greyscale
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // no interlace

  // One filter byte per scanline, then the pixels.
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width)] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[y * (1 + width) + 1 + x] = (x * 7 + y * 3) % 256;
    }
  }

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  return new Uint8Array(png.buffer.slice(png.byteOffset, png.byteOffset + png.length));
}

// --- HTTP --------------------------------------------------------------------

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
      userAgent: "demo-websites-test",
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

async function readReply(response: Response): Promise<Reply> {
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body, raw, headers: response.headers };
}

async function get(url: string, cookie?: string): Promise<Reply> {
  const response = await fetch(`${BASE_URL}${url}`, {
    headers: cookie ? { cookie } : {},
    // The portal redirects unauthenticated *pages*; the API answers 401. Either
    // way a redirect must not be followed, or the status under test is lost.
    redirect: "manual",
  });
  return readReply(response);
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
  return readReply(response);
}

/** A multipart upload, with the same origin headers minus the content type. */
async function upload(
  url: string,
  cookie: string,
  bytes: Uint8Array,
  fileName = "demo.png",
  declaredType = "image/png",
): Promise<Reply> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: declaredType }), fileName);

  const response = await fetch(`${BASE_URL}${url}`, {
    method: "POST",
    headers: { cookie, origin, "sec-fetch-site": "same-origin" },
    body: form,
    redirect: "manual",
  });
  return readReply(response);
}

interface Card {
  id: string;
  name: string;
  clientName: string;
  demoUrl: string;
  status: string;
  notes: string;
  image: { width: number; height: number; fileSize: number; updatedAt: string } | null;
}

function cardsOf(reply: Reply): Card[] {
  return (reply.body.demoWebsites as Card[] | undefined) ?? [];
}

function cardOf(reply: Reply): Card | null {
  return (reply.body.demoWebsite as Card | undefined) ?? null;
}

function metaOf(reply: Reply): { page: number; pageSize: number; total: number; totalPages: number } {
  return (
    (reply.body.meta as { page: number; pageSize: number; total: number; totalPages: number } | undefined) ?? {
      page: 0,
      pageSize: 0,
      total: -1,
      totalPages: -1,
    }
  );
}

// --- the run -----------------------------------------------------------------

async function main(): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const createdIds: string[] = [];

  console.log(`\nDemo Websites — module access, CRUD and the boundary around it — ${BASE_URL}\n`);

  // =========================================================================
  section("Pure rules — the demo link");
  // =========================================================================
  // No server needed for these. They are here rather than in a file of their
  // own because a URL that is accepted by the validator and refused by the
  // route (or the other way round) is the bug worth catching, and running both
  // in one pass is what makes that visible.

  const urlAccepts: Array<[string, string]> = [
    ["https://example-demo.com", "https://example-demo.com/"],
    ["http://example-demo.com/menu", "http://example-demo.com/menu"],
    ["example-demo.com", "https://example-demo.com/"],
    ["  https://example-demo.com/a?b=c  ", "https://example-demo.com/a?b=c"],
    ["//example-demo.com", "https://example-demo.com/"],
  ];
  for (const [input, expected] of urlAccepts) {
    let actual = "";
    try {
      actual = normaliseDemoUrl(input);
    } catch (error) {
      actual = `threw: ${(error as Error).message}`;
    }
    check(`normaliseDemoUrl(${JSON.stringify(input)}) -> ${expected}`, actual === expected, actual);
  }

  const urlRefuses = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example-demo.com",
    "vbscript:msgbox(1)",
    "https://user:pass@example-demo.com",
    "https://localhost",
    "https://",
    "",
    "   ",
    "https://example-demo.com/\r\nSet-Cookie: a=b",
    `https://example-demo.com/${"a".repeat(3000)}`,
  ];
  for (const input of urlRefuses) {
    let refused = false;
    let detail = "";
    try {
      detail = normaliseDemoUrl(input);
    } catch (error) {
      refused = error instanceof DemoWebsiteError;
    }
    check(`normaliseDemoUrl refuses ${JSON.stringify(input.slice(0, 46))}`, refused, `returned ${detail}`);
  }

  // =========================================================================
  section("Pure rules — the image sniffer");
  // =========================================================================
  const png = realPng(320, 200);
  const jpeg = fakeJpeg(800, 600);

  check("a real PNG is identified, with its true size", (() => {
    const facts = sniffDemoImage(png);
    return facts?.type === "image/png" && facts.width === 320 && facts.height === 200;
  })());

  check("a JPEG is identified, with its true size", (() => {
    const facts = sniffDemoImage(jpeg);
    return facts?.type === "image/jpeg" && facts.width === 800 && facts.height === 600;
  })());

  const notImages: Array<[string, Uint8Array]> = [
    ["an HTML page named .png", Buffer.from(`<html><script>alert(1)</script></html>${"x".repeat(400)}`)],
    ["an SVG", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>${"x".repeat(400)}`)],
    ["a PDF", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(500, 0x41)])],
    ["the PNG signature with rubbish after it", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 0x41)])],
    ["a truncated PNG", Buffer.from(png.subarray(0, 12))],
    ["empty", Buffer.alloc(0)],
  ].map(([label, buffer]) => [
    label as string,
    new Uint8Array((buffer as Buffer).buffer.slice((buffer as Buffer).byteOffset, (buffer as Buffer).byteOffset + (buffer as Buffer).length)),
  ]);

  for (const [label, bytes] of notImages) {
    check(`the sniffer refuses ${label}`, sniffDemoImage(bytes) === null);
  }

  check(
    "the application's default module grant matches the column defaults",
    DEFAULT_MODULE_ACCESS.leads === true && DEFAULT_MODULE_ACCESS.demoWebsites === false,
  );

  // =========================================================================
  // Fixtures
  // =========================================================================
  const [admin, both, demoOnly, leadsOnly] = await Promise.all(
    (
      [
        ["admin", "Demo Admin", "ADMIN", true, false],
        ["both", "Demo Agent Both", "AGENT", true, true],
        ["demoonly", "Demo Agent Demo Only", "AGENT", false, true],
        ["leadsonly", "Demo Agent Leads Only", "AGENT", true, false],
      ] as const
    ).map(async ([stem, name, role, leads, demos]) =>
      prisma.user.create({
        data: {
          username: `dwtest-${stem}-${suffix}`,
          email: `dwtest-${stem}-${suffix}@example.invalid`,
          name: `${name} ${suffix}`,
          passwordHash: await hashPassword(PASSWORD),
          role,
          isActive: true,
          canAccessLeads: leads,
          canAccessDemoWebsites: demos,
        },
        select: { id: true, name: true },
      }),
    ),
  );

  // What the lead side of the portal looks like before any of this runs. Nothing
  // below writes a lead, a recording or a meeting; these are compared at the end.
  const before = {
    leads: await prisma.lead.count(),
    recordings: await prisma.meetingRecording.count(),
    activity: await prisma.leadActivity.count(),
    meetings: await prisma.lead.count({ where: { NOT: { meetingTime: null } } }),
    leadIds: (
      await prisma.lead.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 200 })
    ).map((row) => row.id),
    updatedAt: (
      await prisma.lead.findMany({ select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 })
    )[0]?.updatedAt ?? null,
  };

  try {
    const [adminCookie, bothCookie, demoCookie, leadsCookie] = await Promise.all([
      signIn(admin.id),
      signIn(both.id),
      signIn(demoOnly.id),
      signIn(leadsOnly.id),
    ]);

    // =======================================================================
    section("Authorization — who may read the list");
    // =======================================================================
    const anonymous = await get(API);
    check("a signed-out caller gets 401", anonymous.status === 401, `status ${anonymous.status}`);

    const adminList = await get(API, adminCookie);
    check("an administrator gets 200", adminList.status === 200, `status ${adminList.status}`);

    const bothList = await get(API, bothCookie);
    check(
      "an agent with the Demo Websites module gets 200",
      bothList.status === 200,
      `status ${bothList.status}`,
    );

    const demoList = await get(API, demoCookie);
    check(
      "an agent with Demo Websites but not Leads gets 200",
      demoList.status === 200,
      `status ${demoList.status}`,
    );

    const leadsList = await get(API, leadsCookie);
    check(
      "an agent without the Demo Websites module gets 403",
      leadsList.status === 403,
      `status ${leadsList.status}`,
    );
    check(
      "and the 403 body carries no demo website data",
      cardsOf(leadsList).length === 0 && !("meta" in leadsList.body),
    );

    const anonPage = await get("/demo-websites");
    check(
      "a signed-out caller is redirected away from the page",
      anonPage.status === 307 || anonPage.status === 302,
      `status ${anonPage.status}`,
    );

    // =======================================================================
    section("Creating — administrators only");
    // =======================================================================
    for (const [label, cookie] of [
      ["an agent with the module", bothCookie],
      ["an agent without it", leadsCookie],
    ] as const) {
      const refused = await send("POST", API, cookie, {
        name: "Should never exist",
        demoUrl: "https://evil-demo.invalid",
      });
      check(`${label} cannot POST a demo website`, refused.status === 403, `status ${refused.status}`);
    }

    const created = await send("POST", API, adminCookie, {
      name: `Example Restaurant Demo ${suffix}`,
      clientName: "ABC Restaurant",
      demoUrl: "example-restaurant-demo.test",
      phone: "+44 7700 900123",
      email: "OWNER@abc-restaurant.test",
      status: "active",
      notes: "Menu page is the one to show first.",
      // Fields the client must not be able to set. Every one of these is either
      // server-owned or does not exist as an input; none may reach the row.
      id: "forged-id",
      createdById: leadsOnly.id,
      imageStorageKey: "../../../../etc/passwd",
      imageFormat: "text/html",
      createdAt: "1999-01-01T00:00:00.000Z",
      userId: leadsOnly.id,
      role: "ADMIN",
    });
    check("an administrator can create one", created.status === 201, `status ${created.status}`);

    const record = cardOf(created);
    if (!record) throw new Error("the create returned no record; the rest of the run cannot continue");
    createdIds.push(record.id);

    check("the id is server-generated, not the one posted", record.id !== "forged-id", record.id);
    check(
      "a schemeless demo link is normalised to https",
      record.demoUrl === "https://example-restaurant-demo.test/",
      record.demoUrl,
    );
    check("the email is normalised to lower case", (
      await prisma.demoWebsite.findUnique({ where: { id: record.id }, select: { email: true } })
    )?.email === "owner@abc-restaurant.test");

    const row = await prisma.demoWebsite.findUnique({
      where: { id: record.id },
      select: { createdById: true, imageStorageKey: true, imageFormat: true, createdAt: true },
    });
    check(
      "the author is the session's administrator, not the posted userId",
      row?.createdById === admin.id,
      String(row?.createdById),
    );
    check("the posted storage key was ignored", row?.imageStorageKey === null);
    check("the posted image format was ignored", row?.imageFormat === null);
    check(
      "the posted createdAt was ignored",
      (row?.createdAt?.getFullYear() ?? 0) >= 2020,
      String(row?.createdAt),
    );
    check("no image is attached to a new record", record.image === null);

    // =======================================================================
    section("Creating — the demo link is validated at the endpoint too");
    // =======================================================================
    for (const badUrl of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "https://user:pass@example.test",
      "not a url at all",
    ]) {
      const refused = await send("POST", API, adminCookie, {
        name: "Bad link demo",
        demoUrl: badUrl,
      });
      check(
        `POST refuses ${JSON.stringify(badUrl.slice(0, 40))}`,
        refused.status === 400 && refused.body.error === "invalid_url",
        `status ${refused.status} ${String(refused.body.error)}`,
      );
    }

    const noName = await send("POST", API, adminCookie, { name: "x", demoUrl: "https://a.test" });
    check("POST refuses a one-character name", noName.status === 400, `status ${noName.status}`);

    const badStatus = await send("POST", API, adminCookie, {
      name: "Bad status demo",
      demoUrl: "https://a.test",
      status: "not_called",
    });
    check(
      "POST refuses a lead's call status as a demo status",
      badStatus.status === 400 && badStatus.body.error === "invalid_status",
      `status ${badStatus.status}`,
    );

    // =======================================================================
    section("Reading one record");
    // =======================================================================
    const detailForAgent = await get(`${API}/${record.id}`, bothCookie);
    check(
      "an agent with the module can read one record",
      detailForAgent.status === 200,
      `status ${detailForAgent.status}`,
    );
    check(
      "and the payload carries no storage key or filesystem path",
      !/imageStorageKey|storageKey|\/var\/|\.data|C:\\\\/.test(detailForAgent.raw),
      detailForAgent.raw.slice(0, 160),
    );

    const detailForOutsider = await get(`${API}/${record.id}`, leadsCookie);
    check(
      "an agent without the module gets 403 for a record whose id they know",
      detailForOutsider.status === 403,
      `status ${detailForOutsider.status}`,
    );

    const missing = await get(`${API}/clnonexistentid00000000`, adminCookie);
    check("an unknown id is 404", missing.status === 404, `status ${missing.status}`);

    // =======================================================================
    section("Editing — administrators only");
    // =======================================================================
    for (const [label, cookie] of [
      ["an agent with the module", bothCookie],
      ["an agent without it", leadsCookie],
    ] as const) {
      const refused = await send("PATCH", `${API}/${record.id}`, cookie, { status: "archived" });
      check(`${label} cannot PATCH a demo website`, refused.status === 403, `status ${refused.status}`);
    }

    const stillActive = await prisma.demoWebsite.findUnique({
      where: { id: record.id },
      select: { status: true },
    });
    check("and the refused edits changed nothing", stillActive?.status === "active", String(stillActive?.status));

    const edited = await send("PATCH", `${API}/${record.id}`, adminCookie, {
      status: "presented",
      notes: "Shown on the 18th.",
      // Again: server-owned fields offered to a whitelist that does not know them.
      imageStorageKey: "../../etc/shadow",
      id: "another-forged-id",
      createdById: leadsOnly.id,
    });
    check("an administrator can edit one", edited.status === 200, `status ${edited.status}`);
    check("the edit applied", cardOf(edited)?.status === "presented");
    check("the id did not change", cardOf(edited)?.id === record.id);

    const afterEdit = await prisma.demoWebsite.findUnique({
      where: { id: record.id },
      select: { imageStorageKey: true, createdById: true },
    });
    check("the storage key is still unset after a PATCH that tried to set it", afterEdit?.imageStorageKey === null);
    check("the author is unchanged", afterEdit?.createdById === admin.id);

    const emptyPatch = await send("PATCH", `${API}/${record.id}`, adminCookie, {});
    check("an empty PATCH is 400 rather than a silent no-op", emptyPatch.status === 400, `status ${emptyPatch.status}`);

    const badPatchUrl = await send("PATCH", `${API}/${record.id}`, adminCookie, {
      demoUrl: "javascript:alert(1)",
    });
    check(
      "PATCH refuses a javascript: link",
      badPatchUrl.status === 400 && badPatchUrl.body.error === "invalid_url",
      `status ${badPatchUrl.status}`,
    );

    // =======================================================================
    section("The image — uploading");
    // =======================================================================
    const imageUrl = `${API}/${record.id}/image`;

    const beforeUpload = await get(imageUrl, adminCookie);
    check("a record with no image answers 404", beforeUpload.status === 404, `status ${beforeUpload.status}`);

    for (const [label, cookie] of [
      ["an agent with the module", bothCookie],
      ["an agent without it", leadsCookie],
    ] as const) {
      const refused = await upload(imageUrl, cookie, png);
      check(`${label} cannot upload an image`, refused.status === 403, `status ${refused.status}`);
    }

    const uploaded = await upload(imageUrl, adminCookie, png);
    check("an administrator can upload an image", uploaded.status === 201, `status ${uploaded.status} ${uploaded.raw.slice(0, 120)}`);

    const withImage = cardOf(uploaded);
    check(
      "the stored dimensions are read from the file, not from the request",
      withImage?.image?.width === 320 && withImage?.image?.height === 200,
      JSON.stringify(withImage?.image),
    );

    const storedRow = await prisma.demoWebsite.findUnique({
      where: { id: record.id },
      select: { imageStorageKey: true, imageFormat: true },
    });
    const firstKey = storedRow?.imageStorageKey ?? null;
    check("the row now carries a server-generated key", typeof firstKey === "string" && firstKey.length > 0);
    check(
      "the key contains no traversal and stays under the store",
      firstKey !== null && !firstKey.includes("..") && !path.isAbsolute(firstKey),
      String(firstKey),
    );
    check("the stored format was sniffed, not declared", storedRow?.imageFormat === "image/png");

    // A file whose declared type and extension both lie. The sniff is the
    // authority, so this must be stored as the JPEG it actually is.
    const liar = await upload(imageUrl, adminCookie, jpeg, "screenshot.png", "image/png");
    check("an upload whose declared type lies is stored as what it really is", (
      await prisma.demoWebsite.findUnique({ where: { id: record.id }, select: { imageFormat: true } })
    )?.imageFormat === "image/jpeg", `status ${liar.status}`);

    const secondKey = (
      await prisma.demoWebsite.findUnique({ where: { id: record.id }, select: { imageStorageKey: true } })
    )?.imageStorageKey ?? null;
    check("replacing the image writes a new key", secondKey !== firstKey);
    check(
      "and the replaced file is gone from disk, not orphaned",
      firstKey === null || !(await fileExists(firstKey)),
      String(firstKey),
    );

    // =======================================================================
    section("The image — what is refused");
    // =======================================================================
    const htmlBytes = Buffer.from(`<html><script>alert(1)</script></html>${"x".repeat(400)}`);
    const asHtml = await upload(
      imageUrl,
      adminCookie,
      new Uint8Array(htmlBytes.buffer.slice(htmlBytes.byteOffset, htmlBytes.byteOffset + htmlBytes.length)),
      "page.png",
      "image/png",
    );
    check(
      "an HTML file named .png is refused",
      asHtml.status === 415,
      `status ${asHtml.status}`,
    );

    const svgBytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>${"x".repeat(400)}`);
    const asSvg = await upload(
      imageUrl,
      adminCookie,
      new Uint8Array(svgBytes.buffer.slice(svgBytes.byteOffset, svgBytes.byteOffset + svgBytes.length)),
      "logo.svg",
      "image/svg+xml",
    );
    check("an SVG is refused", asSvg.status === 415, `status ${asSvg.status}`);

    const empty = await upload(imageUrl, adminCookie, new Uint8Array(0));
    check("an empty file is refused", empty.status === 400, `status ${empty.status}`);

    const oversized = new Uint8Array(6 * 1024 * 1024);
    oversized.set(png.subarray(0, Math.min(png.length, oversized.length)));
    const tooBig = await upload(imageUrl, adminCookie, oversized);
    check("a 6MB upload is refused with 413", tooBig.status === 413, `status ${tooBig.status}`);

    const noFile = await fetch(`${BASE_URL}${imageUrl}`, {
      method: "POST",
      headers: { cookie: adminCookie, origin, "sec-fetch-site": "same-origin" },
      body: new FormData(),
      redirect: "manual",
    }).then(readReply);
    check("a multipart body with no file is refused", noFile.status === 400, `status ${noFile.status}`);

    const surviving = await prisma.demoWebsite.findUnique({
      where: { id: record.id },
      select: { imageStorageKey: true, imageFormat: true },
    });
    check(
      "and none of those refusals disturbed the image that was already there",
      surviving?.imageStorageKey === secondKey && surviving?.imageFormat === "image/jpeg",
    );

    // =======================================================================
    section("The image — who may see it");
    // =======================================================================
    const anonImage = await fetch(`${BASE_URL}${imageUrl}`, { redirect: "manual" });
    check("a signed-out caller cannot fetch the image", anonImage.status === 401, `status ${anonImage.status}`);
    await anonImage.body?.cancel();

    const outsiderImage = await fetch(`${BASE_URL}${imageUrl}`, {
      headers: { cookie: leadsCookie },
      redirect: "manual",
    });
    check(
      "an agent without the module cannot fetch the image by guessing its URL",
      outsiderImage.status === 403,
      `status ${outsiderImage.status}`,
    );
    await outsiderImage.body?.cancel();

    const grantedImage = await fetch(`${BASE_URL}${imageUrl}`, {
      headers: { cookie: bothCookie },
      redirect: "manual",
    });
    check("an agent with the module can view the image", grantedImage.status === 200, `status ${grantedImage.status}`);
    check(
      "served with the sniffed type and nosniff",
      grantedImage.headers.get("content-type") === "image/jpeg" &&
        grantedImage.headers.get("x-content-type-options") === "nosniff",
      `${grantedImage.headers.get("content-type")} / ${grantedImage.headers.get("x-content-type-options")}`,
    );
    // `proxy.ts` stamps `no-store` over every authenticated response, so that
    // is what actually reaches the browser — checked here rather than the
    // route's own header, because the header that matters is the one sent.
    check(
      "never stored by any cache",
      (grantedImage.headers.get("cache-control") ?? "").includes("no-store"),
      String(grantedImage.headers.get("cache-control")),
    );
    check(
      "and the filename it offers exposes no storage layout",
      !(grantedImage.headers.get("content-disposition") ?? "").includes("/"),
      String(grantedImage.headers.get("content-disposition")),
    );
    const servedBytes = new Uint8Array(await grantedImage.arrayBuffer());
    check(
      "the bytes served are the image that was stored",
      servedBytes.length === jpeg.length && servedBytes[0] === 0xff && servedBytes[1] === 0xd8,
      `${servedBytes.length} bytes`,
    );

    // The one shape of traversal a caller can even attempt: the id segment.
    for (const attempt of [
      "..%2f..%2f..%2fetc%2fpasswd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      `${record.id}%00.png`,
    ]) {
      const traversal = await get(`${API}/${attempt}/image`, adminCookie);
      check(
        `a traversal-shaped id (${attempt.slice(0, 24)}) returns no file`,
        traversal.status === 404 || traversal.status === 400,
        `status ${traversal.status}`,
      );
    }

    // =======================================================================
    section("The image — removing it");
    // =======================================================================
    for (const [label, cookie] of [
      ["an agent with the module", bothCookie],
      ["an agent without it", leadsCookie],
    ] as const) {
      const refused = await send("DELETE", imageUrl, cookie);
      check(`${label} cannot delete an image`, refused.status === 403, `status ${refused.status}`);
    }
    check(
      "and the image is still attached after those refusals",
      (await prisma.demoWebsite.findUnique({ where: { id: record.id }, select: { imageStorageKey: true } }))
        ?.imageStorageKey === secondKey,
    );

    const removedImage = await send("DELETE", imageUrl, adminCookie);
    check("an administrator can remove the image", removedImage.status === 200, `status ${removedImage.status}`);
    check("the row's image columns are cleared", (() => {
      const card = (removedImage.body.demoWebsite as Card | undefined) ?? null;
      return card?.image === null;
    })());
    check(
      "the file is gone from disk",
      secondKey === null || !(await fileExists(secondKey)),
      String(secondKey),
    );
    check("the removal reports no orphan", removedImage.body.imageOrphaned === false);

    const afterRemoval = await get(imageUrl, adminCookie);
    check("and the image endpoint is 404 again", afterRemoval.status === 404, `status ${afterRemoval.status}`);

    // =======================================================================
    section("Search, filters, sorting and paging");
    // =======================================================================
    const fixtures = await Promise.all(
      [
        ["Dental Demo", "XYZ Dental", "https://xyz-dental.test/", "draft", "01611234567", "hi@xyz-dental.test"],
        ["Barber Demo", "Sharp Cuts", "https://sharp-cuts.test/", "active", "01617654321", "hi@sharp-cuts.test"],
        ["Gym Demo", "Iron Works", "https://iron-works.test/", "archived", null, null],
        ["Cafe Demo", "Bean There", "https://bean-there.test/", "presented", null, null],
      ].map(([name, clientName, demoUrl, status, phone, email]) =>
        prisma.demoWebsite.create({
          data: {
            name: `${name} ${suffix}`,
            clientName: clientName as string,
            demoUrl: demoUrl as string,
            status: status as "draft" | "active" | "archived" | "presented",
            phone: phone as string | null,
            email: email as string | null,
            createdById: admin.id,
          },
          select: { id: true },
        }),
      ),
    );
    createdIds.push(...fixtures.map((created) => created.id));

    const mine = `q=${encodeURIComponent(suffix)}`;

    const searched = await get(`${API}?${mine}&pageSize=100`, adminCookie);
    check(
      "a search over the fixture's suffix finds exactly its five records",
      metaOf(searched).total === 5,
      `total ${metaOf(searched).total}`,
    );

    const byClient = await get(`${API}?q=${encodeURIComponent("Iron Works")}&pageSize=100`, adminCookie);
    check("search matches the client name", cardsOf(byClient).some((card) => card.clientName === "Iron Works"));

    const byUrl = await get(`${API}?q=${encodeURIComponent("sharp-cuts")}&pageSize=100`, adminCookie);
    check("search matches the demo URL", cardsOf(byUrl).some((card) => card.demoUrl.includes("sharp-cuts")));

    const byPhone = await get(`${API}?q=01617654321&pageSize=100`, adminCookie);
    check("search matches the phone number", cardsOf(byPhone).length === 1);

    const byEmail = await get(`${API}?q=${encodeURIComponent("hi@xyz-dental.test")}&pageSize=100`, adminCookie);
    check("search matches the email address", cardsOf(byEmail).length === 1);

    const caseInsensitive = await get(`${API}?q=${encodeURIComponent("IRON WORKS")}&pageSize=100`, adminCookie);
    check("search is case-insensitive", cardsOf(caseInsensitive).some((card) => card.clientName === "Iron Works"));

    // Not "does it escape quotes" — Prisma binds every value — but "is the term
    // treated as text". If it were interpolated, `' OR 1=1--` would match rows
    // it has no business matching, or the request would fail.
    for (const injection of ["' OR 1=1--", "'; DROP TABLE demo_websites; --", "%' OR name LIKE '%"]) {
      const attempt = await get(`${API}?q=${encodeURIComponent(injection)}&pageSize=100`, adminCookie);
      check(
        `an injection-shaped search (${injection.slice(0, 20)}) matches nothing and does not error`,
        attempt.status === 200 && metaOf(attempt).total === 0,
        `status ${attempt.status} total ${metaOf(attempt).total}`,
      );
    }
    check(
      "and the table is still there afterwards",
      (await prisma.demoWebsite.count({ where: { id: { in: createdIds } } })) === createdIds.length,
    );

    const drafts = await get(`${API}?${mine}&status=draft&pageSize=100`, adminCookie);
    check(
      "the status filter narrows to one",
      metaOf(drafts).total === 1 && cardsOf(drafts)[0]?.status === "draft",
      `total ${metaOf(drafts).total}`,
    );

    const bogusStatus = await get(`${API}?${mine}&status=not_a_status&pageSize=100`, adminCookie);
    check(
      "an unknown status is ignored rather than 400",
      bogusStatus.status === 200 && metaOf(bogusStatus).total === 5,
      `status ${bogusStatus.status} total ${metaOf(bogusStatus).total}`,
    );

    const counts = searched.body.statusCounts as Record<string, number> | undefined;
    check(
      "status counts are present and non-negative for every status",
      counts !== undefined &&
        ["draft", "active", "presented", "archived"].every(
          (key) => typeof counts[key] === "number" && counts[key]! >= 0,
        ),
      JSON.stringify(counts),
    );

    const nameAsc = await get(`${API}?${mine}&sort=name&dir=asc&pageSize=100`, adminCookie);
    const namesAsc = cardsOf(nameAsc).map((card) => card.name);
    check(
      "sorting by name ascending really is ascending",
      namesAsc.every((name, index) => index === 0 || namesAsc[index - 1]!.localeCompare(name) <= 0),
      namesAsc.join(" | "),
    );

    const nameDesc = await get(`${API}?${mine}&sort=name&dir=desc&pageSize=100`, adminCookie);
    check(
      "and descending is its reverse",
      cardsOf(nameDesc).map((card) => card.name).join("|") === [...namesAsc].reverse().join("|"),
    );

    const bogusSort = await get(`${API}?${mine}&sort=passwordHash&dir=DROP&pageSize=100`, adminCookie);
    check(
      "an unknown sort key falls back to the default rather than reaching SQL",
      bogusSort.status === 200 && metaOf(bogusSort).total === 5,
      `status ${bogusSort.status}`,
    );

    const pageOne = await get(`${API}?${mine}&pageSize=10&page=1`, adminCookie);
    check("the pager reports the right size", metaOf(pageOne).pageSize === 10, `pageSize ${metaOf(pageOne).pageSize}`);

    const smallPages = await get(`${API}?${mine}&sort=name&dir=asc&pageSize=10&page=1`, adminCookie);
    check("page 1 of 10 holds all five", cardsOf(smallPages).length === 5);

    const hugePageSize = await get(`${API}?${mine}&pageSize=100000`, adminCookie);
    check(
      "?pageSize=100000 is not a way to ask for the whole table",
      (DEMO_PAGE_SIZES as readonly number[]).includes(metaOf(hugePageSize).pageSize),
      `pageSize ${metaOf(hugePageSize).pageSize}`,
    );

    const farPage = await get(`${API}?${mine}&page=9999&pageSize=10`, adminCookie);
    check(
      "a page past the end is clamped rather than empty-with-a-lie",
      metaOf(farPage).page === metaOf(farPage).totalPages,
      `page ${metaOf(farPage).page} of ${metaOf(farPage).totalPages}`,
    );

    // Two pages of two, walked and compared to the single-page read.
    const walkA = await get(`${API}?${mine}&sort=name&dir=asc&pageSize=10&page=1`, adminCookie);
    const walked = cardsOf(walkA).map((card) => card.id);
    check(
      "walking the pages yields each record exactly once",
      new Set(walked).size === walked.length && walked.length === 5,
      `${walked.length} rows, ${new Set(walked).size} distinct`,
    );

    // =======================================================================
    section("Deleting — administrators only, and the image goes with it");
    // =======================================================================
    const doomed = fixtures[0]!;
    await upload(`${API}/${doomed.id}/image`, adminCookie, png);
    const doomedKey = (
      await prisma.demoWebsite.findUnique({ where: { id: doomed.id }, select: { imageStorageKey: true } })
    )?.imageStorageKey ?? null;
    check("the record to be deleted has an image on disk", doomedKey !== null && (await fileExists(doomedKey)));

    for (const [label, cookie] of [
      ["an agent with the module", bothCookie],
      ["an agent without it", leadsCookie],
    ] as const) {
      const refused = await send("DELETE", `${API}/${doomed.id}`, cookie);
      check(`${label} cannot DELETE a demo website`, refused.status === 403, `status ${refused.status}`);
    }
    check(
      "and the record survived those attempts",
      (await prisma.demoWebsite.count({ where: { id: doomed.id } })) === 1,
    );

    const deleted = await send("DELETE", `${API}/${doomed.id}`, adminCookie);
    check("an administrator can delete one", deleted.status === 200, `status ${deleted.status}`);
    check("the row is gone", (await prisma.demoWebsite.count({ where: { id: doomed.id } })) === 0);
    check(
      "and its image file is gone with it — no orphan",
      doomedKey !== null && !(await fileExists(doomedKey)) && deleted.body.imageOrphaned === false,
    );

    const deleteAgain = await send("DELETE", `${API}/${doomed.id}`, adminCookie);
    check("a second delete is 404 rather than an error", deleteAgain.status === 404, `status ${deleteAgain.status}`);

    // =======================================================================
    section("Cross-site requests");
    // =======================================================================
    const crossSite = await fetch(`${BASE_URL}${API}`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "From another origin", demoUrl: "https://evil.example" }),
      redirect: "manual",
    }).then(readReply);
    check(
      "a cross-site POST with a valid admin cookie is refused",
      crossSite.status === 403,
      `status ${crossSite.status}`,
    );
    check(
      "and nothing was created by it",
      (await prisma.demoWebsite.count({ where: { name: "From another origin" } })) === 0,
    );

    // =======================================================================
    section("Module access is server-side, and changes take effect at once");
    // =======================================================================
    await prisma.user.update({
      where: { id: both.id },
      data: { canAccessDemoWebsites: false },
    });
    const afterRevoke = await get(API, bothCookie);
    check(
      "removing the module refuses the very next request, with no sign-out",
      afterRevoke.status === 403,
      `status ${afterRevoke.status}`,
    );
    const afterRevokeImage = await get(`${API}/${record.id}`, bothCookie);
    check("including the detail endpoint", afterRevokeImage.status === 403, `status ${afterRevokeImage.status}`);

    await prisma.user.update({ where: { id: both.id }, data: { canAccessDemoWebsites: true } });
    const afterRestore = await get(API, bothCookie);
    check("and granting it back restores access just as quickly", afterRestore.status === 200, `status ${afterRestore.status}`);

    // The Leads side of the same switch.
    const leadsForDemoOnly = await get("/api/leads", demoCookie);
    check(
      "an agent without the Leads module is refused by the leads API",
      leadsForDemoOnly.status === 403,
      `status ${leadsForDemoOnly.status}`,
    );
    const leadsForLeadsAgent = await get("/api/leads", leadsCookie);
    check(
      "an agent with the Leads module still reads leads exactly as before",
      leadsForLeadsAgent.status === 200,
      `status ${leadsForLeadsAgent.status}`,
    );
    const recordingsForDemoOnly = await get("/api/recordings", demoCookie);
    check(
      "and call recordings, which belong to Leads, are refused for them too",
      recordingsForDemoOnly.status === 403,
      `status ${recordingsForDemoOnly.status}`,
    );
    check(
      "removing Leads did not affect their Demo Websites access",
      (await get(API, demoCookie)).status === 200,
    );

    // An administrator is never subject to the columns, whatever they say.
    await prisma.user.update({
      where: { id: admin.id },
      data: { canAccessLeads: false, canAccessDemoWebsites: false },
    });
    const adminDespiteFlags = await get(API, adminCookie);
    check(
      "an administrator keeps both modules even with both columns false",
      adminDespiteFlags.status === 200 && (await get("/api/leads", adminCookie)).status === 200,
      `status ${adminDespiteFlags.status}`,
    );
    await prisma.user.update({
      where: { id: admin.id },
      data: { canAccessLeads: true, canAccessDemoWebsites: true },
    });

    // =======================================================================
    section("Nobody can grant themselves a module");
    // =======================================================================
    const selfGrant = await send("PATCH", `/api/users/${demoOnly.id}`, demoCookie, {
      canAccessLeads: true,
    });
    check(
      "an agent PATCHing their own user row is refused outright",
      selfGrant.status === 403,
      `status ${selfGrant.status}`,
    );
    check(
      "and gained nothing",
      (await prisma.user.findUnique({ where: { id: demoOnly.id }, select: { canAccessLeads: true } }))
        ?.canAccessLeads === false,
    );

    const adminSelfEdit = await send("PATCH", `/api/users/${admin.id}`, adminCookie, {
      canAccessDemoWebsites: false,
    });
    check(
      "an administrator cannot edit their own module access either",
      adminSelfEdit.status === 400 && adminSelfEdit.body.error === "self_edit_refused",
      `status ${adminSelfEdit.status}`,
    );

    const grantByAdmin = await send("PATCH", `/api/users/${leadsOnly.id}`, adminCookie, {
      canAccessDemoWebsites: true,
    });
    check("an administrator can grant a module to somebody else", grantByAdmin.status === 200, `status ${grantByAdmin.status}`);
    check(
      "and the agent can read demo websites on their next request",
      (await get(API, leadsCookie)).status === 200,
    );
    await send("PATCH", `/api/users/${leadsOnly.id}`, adminCookie, { canAccessDemoWebsites: false });
    check("revoking it again works the same way", (await get(API, leadsCookie)).status === 403);

    const coerced = await send("PATCH", `/api/users/${leadsOnly.id}`, adminCookie, {
      canAccessDemoWebsites: "true",
    });
    check(
      'a string "true" is not a grant',
      (await prisma.user.findUnique({ where: { id: leadsOnly.id }, select: { canAccessDemoWebsites: true } }))
        ?.canAccessDemoWebsites === false,
      `status ${coerced.status}`,
    );

    // =======================================================================
    section("The pages, and what the navigation draws");
    // =======================================================================
    // Server-rendered HTML, checked for markers rather than screenshotted. What
    // is being asserted is not "does it look right" — that is a human's job —
    // but that the *server* decided what to send: an agent's markup must not
    // contain a link, a control or a record they may not have.

    const adminScreen = await getPage("/demo-websites", adminCookie);
    check(
      "an administrator gets the Demo Websites screen",
      adminScreen.status === 200 && adminScreen.html.includes("Demo Websites"),
      `status ${adminScreen.status}`,
    );
    check(
      "…with the admin controls on it",
      adminScreen.html.includes("Add Demo Website"),
    );

    const agentScreen = await getPage("/demo-websites", bothCookie);
    check(
      "an agent with the module gets the screen too",
      agentScreen.status === 200 && agentScreen.html.includes("Demo Websites"),
      `status ${agentScreen.status}`,
    );
    check(
      "…and is told it is read-only",
      agentScreen.html.includes("read-only for your account"),
    );
    check(
      "…with no Add control in the markup at all",
      !agentScreen.html.includes("Add Demo Website"),
    );

    const refusedScreen = await getPage("/demo-websites", leadsCookie);
    check(
      "an agent without the module gets Access denied",
      refusedScreen.html.includes("Access denied"),
      `status ${refusedScreen.status}`,
    );
    check(
      "…and no demo website reaches their markup",
      // The fixture's *name*, not the run suffix: the suffix is also in the
      // agent's own display name, which the top bar prints on every screen
      // including this one, so matching on it would fail for the wrong reason.
      !refusedScreen.html.includes("Example Restaurant Demo") &&
        !refusedScreen.html.includes("example-restaurant-demo.test"),
    );

    check(
      "the nav draws Demo Websites for an agent who has it",
      agentScreen.html.includes("/demo-websites"),
    );
    check(
      "and not for an agent who does not",
      !refusedScreen.html.includes('href="/demo-websites"'),
    );

    const demoOnlyMeetings = await getPage("/meetings", demoCookie);
    check(
      "an agent without the Leads module is refused the meetings screen",
      demoOnlyMeetings.html.includes("Access denied"),
      `status ${demoOnlyMeetings.status}`,
    );

    /*
     * `/` is the worklist, and this agent may not open it — so they must be sent
     * onwards rather than refused.
     *
     * Next answers this as a meta refresh rather than a 3xx, because the portal
     * layout has already begun streaming by the time the page runs its guard.
     * That is the *backstop*, not the path anybody normally takes: the sign-in
     * routes send this account straight to `/demo-websites`
     * (`landingRedirectFor`) and the brand mark in the rail points there too, so
     * reaching `/` at all means somebody typed it. Both forms are accepted here
     * because both are correct answers to "do not show them the worklist".
     */
    const demoOnlyHome = await getPage("/", demoCookie);
    const redirected =
      demoOnlyHome.status === 307 ||
      demoOnlyHome.status === 302 ||
      demoOnlyHome.html.includes('http-equiv="refresh" content="1;url=/demo-websites"');
    check(
      "and is sent to Demo Websites rather than shown the worklist",
      redirected,
      `status ${demoOnlyHome.status}`,
    );
    check(
      "…and no lead reaches their markup on the way",
      !demoOnlyHome.html.includes("Rows per page"),
    );

    /*
     * The decision the sign-in routes make, checked directly.
     *
     * Not by posting to `/api/auth/login`: an agent's sign-in issues a one-time
     * code by email, so driving it here would send real mail to a fake address
     * and then need a code no test can read. This is the one function both
     * routes call, imported dynamically because it pulls in `lib/prisma`, which
     * reads `DATABASE_URL` at module load — after `loadEnv` has run, which a
     * top-level import would not be.
     */
    const { landingRedirectFor } = await import("../lib/moduleAccess");

    check(
      "signing in sends a Demo-Websites-only account there, not to the worklist",
      (await landingRedirectFor(demoOnly.id, "/")) === "/demo-websites",
      await landingRedirectFor(demoOnly.id, "/"),
    );
    check(
      "an agent with Leads still lands on the worklist",
      (await landingRedirectFor(leadsOnly.id, "/")) === "/",
      await landingRedirectFor(leadsOnly.id, "/"),
    );
    check(
      "an administrator always lands on the worklist",
      (await landingRedirectFor(admin.id, "/")) === "/",
      await landingRedirectFor(admin.id, "/"),
    );
    check(
      "and a destination the caller actually asked for is never overridden",
      (await landingRedirectFor(demoOnly.id, "/meetings")) === "/meetings",
    );

    const leadsAgentHome = await getPage("/", leadsCookie);
    check(
      "an agent with the Leads module still lands on the worklist",
      leadsAgentHome.status === 200,
      `status ${leadsAgentHome.status}`,
    );

    // =======================================================================
    section("Demo Websites and Leads are separate");
    // =======================================================================
    const after = {
      leads: await prisma.lead.count(),
      recordings: await prisma.meetingRecording.count(),
      activity: await prisma.leadActivity.count(),
      meetings: await prisma.lead.count({ where: { NOT: { meetingTime: null } } }),
      leadIds: (
        await prisma.lead.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 200 })
      ).map((row) => row.id),
      updatedAt: (
        await prisma.lead.findMany({ select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 })
      )[0]?.updatedAt ?? null,
    };

    check("creating demo websites created no leads", after.leads === before.leads, `${before.leads} -> ${after.leads}`);
    check("no lead id changed", after.leadIds.join(",") === before.leadIds.join(","));
    check(
      "no lead row was touched",
      String(after.updatedAt) === String(before.updatedAt),
      `${String(before.updatedAt)} -> ${String(after.updatedAt)}`,
    );
    check("recordings are unchanged", after.recordings === before.recordings);
    check("lead activity is unchanged", after.activity === before.activity);
    check("meetings are unchanged", after.meetings === before.meetings);

    check(
      "no demo website carries a lead id, and no lead carries a demo id",
      (await prisma.demoWebsite.count({ where: { id: { in: before.leadIds } } })) === 0,
    );

    const leadPage = await get("/api/leads?pageSize=100", adminCookie);
    check(
      "the leads endpoint returns no demo websites",
      !leadPage.raw.includes(suffix),
      "a fixture name appeared in the lead payload",
    );

    const demoPage = await get(`${API}?pageSize=100`, adminCookie);
    check(
      "the demo websites endpoint returns no leads",
      before.leadIds.length === 0 ||
        !cardsOf(demoPage).some((card) => before.leadIds.includes(card.id)),
    );

    check(
      "and there is no recording relation on a demo website to upload audio to",
      (await get(`${API}/${record.id}/recording`, adminCookie)).status === 404,
    );
  } finally {
    // ---------------------------------------------------------------------
    // Teardown. Runs after a failure too — a test that leaves users, records
    // and image files behind is a test nobody runs twice.
    // ---------------------------------------------------------------------
    const ids = [admin.id, both.id, demoOnly.id, leadsOnly.id];

    const leftovers = await prisma.demoWebsite.findMany({
      where: { OR: [{ id: { in: createdIds } }, { name: { contains: suffix } }] },
      select: { id: true, imageStorageKey: true },
    });

    for (const leftover of leftovers) {
      if (leftover.imageStorageKey) {
        await rm(path.resolve(demoImageRoot(), leftover.imageStorageKey), { force: true }).catch(() => {});
      }
    }

    await prisma.demoWebsite
      .deleteMany({ where: { id: { in: leftovers.map((row) => row.id) } } })
      .catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});

    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

/** A page, as markup — for the checks about what the server decided to send. */
async function getPage(url: string, cookie: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${BASE_URL}${url}`, {
    headers: { cookie },
    redirect: "manual",
  });
  return { status: response.status, html: await response.text() };
}

/** Whether a storage key still has bytes behind it. */
async function fileExists(key: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(path.resolve(demoImageRoot(), key))).isFile();
  } catch {
    return false;
  }
}

main().catch(async (error) => {
  console.error("\nThe test run itself failed:\n", error);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
