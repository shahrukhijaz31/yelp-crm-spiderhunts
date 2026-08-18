import { createHash, randomBytes } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { demoImageRoot } from "../lib/demoImageStorage";
import { sniffDemoImage } from "../lib/demoImageRules";
import { DemoWebsiteError, normaliseDemoUrl } from "../lib/demoWebsiteRules";
import { DEFAULT_MODULE_ACCESS } from "../lib/modules";
import { hashPassword } from "../lib/password";

/**
 * Demo Websites: the same leads, a second view, two extra fields.
 *
 *   npm run dev                  (in one terminal)
 *   npm run test:demo-websites   (in another)
 *
 * Written for the reason `test-agent-screenshots.ts` gives: every claim worth
 * checking here is a claim about a cookie, a session row, a module column, a
 * `where` clause and an HTTP status. A mocked version of any of them would pass
 * whether or not the real thing works, so this speaks HTTP to the real routes
 * with real session cookies and checks what actually comes back.
 *
 * ---------------------------------------------------------------------------
 * The claim this file exists to prove
 * ---------------------------------------------------------------------------
 * **There is one lead pool and no copy of it.** The Demo Websites view reads
 * `leads`, so a name, a status or a note edited on the worklist is already
 * edited in the demo view — not synchronised, not eventually consistent, the
 * same row. The strongest test below writes a change through the *lead* API and
 * reads it back through the *demo* section, with no demo-side write in between.
 *
 * The second claim is the boundary: an agent granted one section cannot reach
 * the other, by URL, by API, or by changing an id — and an agent granted the
 * demo section is never served an audio control or the endpoint behind one.
 *
 * ---------------------------------------------------------------------------
 * What it creates, and what it never touches
 * ---------------------------------------------------------------------------
 * Four throwaway accounts (`dwtest-*`) with four different grants, their
 * sessions, and three throwaway leads it creates and deletes. No existing lead,
 * recording or meeting is created, edited or deleted, and the counts are
 * compared before and after to prove it.
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

// --- image fixtures ----------------------------------------------------------

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
}

/** A minimal JPEG whose SOF0 states the dimensions. */
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

  return toBytes(
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      comment,
      sof,
      Buffer.from([0x00, 0x01, 0x11, 0x00]),
      Buffer.from([0xff, 0xd9]),
    ]),
  );
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

/** A genuinely valid greyscale PNG, not a header with padding after it. */
function realPng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(0, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width)] = 0;
    for (let x = 0; x < width; x += 1) raw[y * (1 + width) + 1 + x] = (x * 7 + y * 3) % 256;
  }

  return toBytes(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// --- HTTP --------------------------------------------------------------------

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
  return readReply(
    await fetch(`${BASE_URL}${url}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    }),
  );
}

function sameOriginHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

async function send(method: string, url: string, cookie: string, body?: unknown): Promise<Reply> {
  return readReply(
    await fetch(`${BASE_URL}${url}`, {
      method,
      headers: sameOriginHeaders(cookie),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }),
  );
}

async function upload(
  url: string,
  cookie: string,
  bytes: Uint8Array,
  fileName = "demo.png",
  declaredType = "image/png",
): Promise<Reply> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: declaredType }), fileName);

  return readReply(
    await fetch(`${BASE_URL}${url}`, {
      method: "POST",
      headers: { cookie, origin, "sec-fetch-site": "same-origin" },
      body: form,
      redirect: "manual",
    }),
  );
}

async function getPage(url: string, cookie: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${BASE_URL}${url}`, { headers: { cookie }, redirect: "manual" });
  return { status: response.status, html: await response.text() };
}

interface LeadRow {
  id: string;
  name: string;
  phone: string | null;
  address: string;
  status: string;
  notes: string;
  owner: string | null;
}

interface DemoSummaryShape {
  leadId: string;
  demoUrl: string | null;
  image: { width: number; height: number; fileSize: number; updatedAt: string } | null;
}

function leadsOf(reply: Reply): LeadRow[] {
  return (reply.body.leads as LeadRow[] | undefined) ?? [];
}

function demosOf(reply: Reply): Record<string, DemoSummaryShape> {
  return (reply.body.demos as Record<string, DemoSummaryShape> | undefined) ?? {};
}

function findLead(reply: Reply, id: string): LeadRow | undefined {
  return leadsOf(reply).find((lead) => lead.id === id);
}

function demoOf(reply: Reply): DemoSummaryShape | null {
  return (reply.body.demo as DemoSummaryShape | null | undefined) ?? null;
}

async function fileExists(key: string): Promise<boolean> {
  try {
    return (await stat(path.resolve(demoImageRoot(), key))).isFile();
  } catch {
    return false;
  }
}

// --- the run -----------------------------------------------------------------

async function main(): Promise<void> {
  const suffix = randomBytes(4).toString("hex");

  console.log(`\nDemo Websites — one lead pool, two views — ${BASE_URL}\n`);

  // =========================================================================
  section("The demo link rule");
  // =========================================================================
  for (const [input, expected] of [
    ["https://example-demo.com", "https://example-demo.com/"],
    ["http://example-demo.com/menu", "http://example-demo.com/menu"],
    ["example-demo.com", "https://example-demo.com/"],
    ["  https://example-demo.com/a?b=c  ", "https://example-demo.com/a?b=c"],
  ] as const) {
    let actual = "";
    try {
      actual = normaliseDemoUrl(input);
    } catch (error) {
      actual = `threw: ${(error as Error).message}`;
    }
    check(`${JSON.stringify(input)} -> ${expected}`, actual === expected, actual);
  }

  for (const input of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "ftp://example-demo.com",
    "//evil.com",
    "//evil.com/path",
    "https://user:pass@example-demo.com",
    "https://localhost",
    "https://",
    "",
    "   ",
    "https://example-demo.com/\r\nSet-Cookie: a=b",
    `https://example-demo.com/${"a".repeat(3000)}`,
  ]) {
    let refused = false;
    let detail = "";
    try {
      detail = normaliseDemoUrl(input);
    } catch (error) {
      refused = error instanceof DemoWebsiteError;
    }
    check(`refuses ${JSON.stringify(input.slice(0, 44))}`, refused, `returned ${detail}`);
  }

  // =========================================================================
  section("The image sniffer");
  // =========================================================================
  const png = realPng(320, 200);
  const jpeg = fakeJpeg(800, 600);

  check(
    "a real PNG is identified, with its true size",
    (() => {
      const facts = sniffDemoImage(png);
      return facts?.type === "image/png" && facts.width === 320 && facts.height === 200;
    })(),
  );
  check(
    "a JPEG is identified, with its true size",
    (() => {
      const facts = sniffDemoImage(jpeg);
      return facts?.type === "image/jpeg" && facts.width === 800 && facts.height === 600;
    })(),
  );

  for (const [label, buffer] of [
    ["an HTML page named .png", Buffer.from(`<html><script>alert(1)</script></html>${"x".repeat(400)}`)],
    ["an SVG", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>${"x".repeat(400)}`)],
    ["a PDF", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(500, 0x41)])],
    [
      "the PNG signature with rubbish after it",
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(500, 0x41),
      ]),
    ],
    ["empty", Buffer.alloc(0)],
  ] as const) {
    check(`the sniffer refuses ${label}`, sniffDemoImage(toBytes(buffer)) === null);
  }

  check(
    "the application's default grant matches the column defaults",
    DEFAULT_MODULE_ACCESS.leads === true && DEFAULT_MODULE_ACCESS.demoWebsites === false,
  );

  // =========================================================================
  // Fixtures
  // =========================================================================
  const [admin, both, demoOnly, leadsOnly] = await Promise.all(
    (
      [
        ["admin", "Demo Admin", "ADMIN", true, false],
        ["both", "Agent Both", "AGENT", true, true],
        ["demoonly", "Agent Demo Only", "AGENT", false, true],
        ["leadsonly", "Agent Leads Only", "AGENT", true, false],
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

  /*
   * Two throwaway leads, created through Prisma rather than the portal so the
   * test does not depend on the import path. They carry the values the "existing
   * lead data carries over" checks look for — a status, notes, an owner, an
   * address — because a lead with empty fields would pass those checks without
   * proving anything.
   */
  const subject = await prisma.lead.create({
    data: {
      name: `Demo Test Restaurant ${suffix}`,
      address: "12 Test Street, Lahore",
      categories: ["Restaurants"],
      phone: `0300${suffix.slice(0, 6)}`,
      website: "example-restaurant.test",
      rating: 4.5,
      owner: "Test Owner",
      status: "interested",
      notes: "Client wants a modern website",
    },
    select: { id: true, name: true },
  });

  const other = await prisma.lead.create({
    data: {
      name: `Demo Test Dental ${suffix}`,
      address: "9 Other Road, Lahore",
      categories: ["Dentists"],
      phone: `0301${suffix.slice(0, 6)}`,
      status: "not_called",
      notes: "",
    },
    select: { id: true, name: true },
  });

  // The state of the world before anything below runs.
  const before = {
    leads: await prisma.lead.count(),
    recordings: await prisma.meetingRecording.count(),
    demoRows: await prisma.demoWebsite.count(),
  };

  try {
    const [adminCookie, bothCookie, demoCookie, leadsCookie] = await Promise.all([
      signIn(admin.id),
      signIn(both.id),
      signIn(demoOnly.id),
      signIn(leadsOnly.id),
    ]);

    const demoList = `/api/leads?section=demo&pageSize=100&q=${encodeURIComponent(suffix)}`;
    const leadList = `/api/leads?pageSize=100&q=${encodeURIComponent(suffix)}`;

    /*
     * The same two lists, on the Called queue.
     *
     * Recording a call outcome sets `first_called_at`, which is what moves a
     * lead from New to Called (`lib/workState.ts`) — so the lead edited below
     * legitimately leaves the queue it started in. That is the worklist's
     * behaviour and the demo view inherits it, which is the point: the two
     * views share the queue, the filters and the pager, not just the rows.
     */
    const demoCalled = `${demoList}&work=called`;
    const leadCalled = `${leadList}&work=called`;

    // =======================================================================
    section("One lead pool — the demo view shows the same records");
    // =======================================================================
    const viaLeads = await get(leadList, adminCookie);
    const viaDemo = await get(demoList, adminCookie);

    check(
      "the lead section returns the fixture leads",
      viaLeads.status === 200 && leadsOf(viaLeads).length === 2,
      `status ${viaLeads.status}, ${leadsOf(viaLeads).length} rows`,
    );
    check("the demo section returns 200", viaDemo.status === 200, `status ${viaDemo.status}`);
    check(
      "…and returns the very same lead ids",
      leadsOf(viaDemo)
        .map((lead) => lead.id)
        .sort()
        .join(",") ===
        leadsOf(viaLeads)
          .map((lead) => lead.id)
          .sort()
          .join(","),
    );

    const demoRow = findLead(viaDemo, subject.id);
    check(
      "the demo view carries the lead's real name, address and owner",
      demoRow?.name === subject.name &&
        demoRow?.address === "12 Test Street, Lahore" &&
        demoRow?.owner === "Test Owner",
      JSON.stringify(demoRow),
    );
    check(
      "…and the status and notes the lead already had",
      demoRow?.status === "interested" && demoRow?.notes === "Client wants a modern website",
      `${demoRow?.status} / ${demoRow?.notes}`,
    );
    check(
      "a lead with no demo row still appears, with no demo metadata",
      findLead(viaDemo, other.id) !== undefined && demosOf(viaDemo)[other.id] === undefined,
    );
    check(
      "and no demo row was created merely by looking",
      (await prisma.demoWebsite.count()) === before.demoRows,
    );

    // =======================================================================
    section("Edits on the worklist appear in the demo view — the same row");
    // =======================================================================
    // The heart of the correction. This writes through the *lead* API and reads
    // back through the *demo* section, with no demo-side write in between.
    const edit = await send("PATCH", `/api/leads/${subject.id}`, adminCookie, {
      status: "no_answer",
      notes: "Call again tomorrow",
    });
    check("an edit through the lead API succeeds", edit.status === 200, `status ${edit.status}`);

    // Read from the Called queue: the edit above is what moved it there, in
    // both views at once.
    const afterEdit = await get(demoCalled, adminCookie);
    const edited = findLead(afterEdit, subject.id);
    check("the demo view shows the new status immediately", edited?.status === "no_answer", String(edited?.status));
    check(
      "the demo view shows the new notes immediately",
      edited?.notes === "Call again tomorrow",
      String(edited?.notes),
    );

    await prisma.lead.update({
      where: { id: subject.id },
      data: { name: `Renamed Restaurant ${suffix}` },
    });
    const renamedDemo = findLead(await get(demoCalled, adminCookie), subject.id);
    const renamedLeads = findLead(await get(leadCalled, adminCookie), subject.id);
    check(
      "a rename appears in both views, with no synchronisation step",
      renamedDemo?.name === `Renamed Restaurant ${suffix}` &&
        renamedLeads?.name === `Renamed Restaurant ${suffix}`,
      `${renamedDemo?.name} / ${renamedLeads?.name}`,
    );

    // =======================================================================
    section("Access — which section each agent may open");
    // =======================================================================
    check("a signed-out caller gets 401 from the demo section", (await get(demoList)).status === 401);
    check("a signed-out caller gets 401 from the lead section", (await get(leadList)).status === 401);
    check(
      "an administrator may read both",
      (await get(demoList, adminCookie)).status === 200 && (await get(leadList, adminCookie)).status === 200,
    );
    check(
      "an agent with both may read both",
      (await get(demoList, bothCookie)).status === 200 && (await get(leadList, bothCookie)).status === 200,
    );

    const demoOnlyDemo = await get(demoList, demoCookie);
    const demoOnlyLeads = await get(leadList, demoCookie);
    check("an agent with Demo Websites only may read the demo section", demoOnlyDemo.status === 200, `status ${demoOnlyDemo.status}`);
    check("…and is refused the New Leads section", demoOnlyLeads.status === 403, `status ${demoOnlyLeads.status}`);
    check("…with no lead in the refusal body", leadsOf(demoOnlyLeads).length === 0);

    const leadsOnlyLeads = await get(leadList, leadsCookie);
    const leadsOnlyDemo = await get(demoList, leadsCookie);
    check("an agent with New Leads only may read the lead section", leadsOnlyLeads.status === 200, `status ${leadsOnlyLeads.status}`);
    check("…and is refused the demo section", leadsOnlyDemo.status === 403, `status ${leadsOnlyDemo.status}`);
    check("…with no lead in the refusal body", leadsOf(leadsOnlyDemo).length === 0);

    for (const spelling of ["section=demo", "section=demo&section=leads"]) {
      const attempt = await get(`/api/leads?${spelling}&pageSize=10`, leadsCookie);
      check(
        `an agent without the module cannot reach the demo section via ?${spelling}`,
        attempt.status === 403,
        `status ${attempt.status}`,
      );
    }
    check(
      "a demo-only agent cannot reach the worklist by omitting the section",
      (await get("/api/leads?pageSize=10", demoCookie)).status === 403,
    );

    // =======================================================================
    section("The demo fields — the link");
    // =======================================================================
    const demoApi = `/api/leads/${subject.id}/demo`;

    check("a signed-out caller cannot read demo metadata", (await get(demoApi)).status === 401);
    check("an agent without the module cannot read demo metadata", (await get(demoApi, leadsCookie)).status === 403);
    check(
      "an agent without the module cannot write a demo link",
      (await send("PATCH", demoApi, leadsCookie, { demoUrl: "https://evil.test" })).status === 403,
    );
    check(
      "…and nothing was written",
      (await prisma.demoWebsite.count({ where: { leadId: subject.id } })) === 0,
    );

    const setLink = await send("PATCH", demoApi, bothCookie, { demoUrl: "example-restaurant-demo.test" });
    check("an agent with the module can set a demo link", setLink.status === 200, `status ${setLink.status} ${setLink.raw.slice(0, 140)}`);
    check(
      "…normalised to https by the server",
      demoOf(setLink)?.demoUrl === "https://example-restaurant-demo.test/",
      JSON.stringify(demoOf(setLink)),
    );
    check(
      "…and it persists across a fresh read",
      demoOf(await get(demoApi, bothCookie))?.demoUrl === "https://example-restaurant-demo.test/",
    );

    const changed = await send("PATCH", demoApi, adminCookie, { demoUrl: "https://changed-demo.test/x" });
    check(
      "changing the link persists the new value",
      demoOf(changed)?.demoUrl === "https://changed-demo.test/x",
      JSON.stringify(demoOf(changed)),
    );

    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.com", "not a url"]) {
      const refused = await send("PATCH", demoApi, adminCookie, { demoUrl: bad });
      check(
        `the endpoint refuses ${JSON.stringify(bad.slice(0, 30))}`,
        refused.status === 400 && refused.body.error === "invalid_url",
        `status ${refused.status} ${String(refused.body.error)}`,
      );
    }
    check(
      "…and none of those refusals changed the stored link",
      (await prisma.demoWebsite.findUnique({ where: { leadId: subject.id }, select: { demoUrl: true } }))
        ?.demoUrl === "https://changed-demo.test/x",
    );

    // A body carrying lead fields sets none of them: they are not read.
    await send("PATCH", demoApi, adminCookie, {
      demoUrl: "https://changed-demo.test/x",
      name: "HACKED",
      status: "do_not_call",
      notes: "HACKED",
      leadId: other.id,
      updatedById: leadsOnly.id,
      imageStorageKey: "../../etc/passwd",
    });
    const untouched = await prisma.lead.findUnique({
      where: { id: subject.id },
      select: { name: true, status: true, notes: true },
    });
    check(
      "lead fields in a demo body are ignored — the lead is untouched",
      untouched?.name === `Renamed Restaurant ${suffix}` &&
        untouched?.status === "no_answer" &&
        untouched?.notes === "Call again tomorrow",
      JSON.stringify(untouched),
    );
    const demoRowNow = await prisma.demoWebsite.findUnique({
      where: { leadId: subject.id },
      select: { leadId: true, imageStorageKey: true, updatedById: true },
    });
    check("…the demo row still points at its own lead", demoRowNow?.leadId === subject.id);
    check("…the posted storage key was ignored", demoRowNow?.imageStorageKey === null);
    check(
      "…and the editor is the session user, not the posted one",
      demoRowNow?.updatedById === admin.id,
      String(demoRowNow?.updatedById),
    );

    // =======================================================================
    section("The demo fields — the image");
    // =======================================================================
    const imageApi = `/api/leads/${subject.id}/demo/image`;

    check("a lead with no image answers 404", (await get(imageApi, adminCookie)).status === 404);
    check("a signed-out caller cannot fetch it", (await get(imageApi)).status === 401);
    check("an agent without the module cannot fetch it", (await get(imageApi, leadsCookie)).status === 403);
    check(
      "an agent without the module cannot upload one",
      (await upload(imageApi, leadsCookie, png)).status === 403,
    );

    const uploaded = await upload(imageApi, bothCookie, png);
    check("an agent with the module can upload an image", uploaded.status === 201, `status ${uploaded.status} ${uploaded.raw.slice(0, 160)}`);
    check(
      "the stored dimensions are read from the file, not the request",
      demoOf(uploaded)?.image?.width === 320 && demoOf(uploaded)?.image?.height === 200,
      JSON.stringify(demoOf(uploaded)?.image),
    );

    const firstKey =
      (
        await prisma.demoWebsite.findUnique({
          where: { leadId: subject.id },
          select: { imageStorageKey: true },
        })
      )?.imageStorageKey ?? null;
    check("the row carries a server-generated key", typeof firstKey === "string" && firstKey.length > 0);
    check(
      "the key contains no traversal and is relative to the store",
      firstKey !== null && !firstKey.includes("..") && !path.isAbsolute(firstKey),
      String(firstKey),
    );
    check("the file is on disk", firstKey !== null && (await fileExists(firstKey)));

    // The declared type and extension both lie; the sniff is the authority.
    await upload(imageApi, adminCookie, jpeg, "screenshot.png", "image/png");
    const afterReplace = await prisma.demoWebsite.findUnique({
      where: { leadId: subject.id },
      select: { imageStorageKey: true, imageFormat: true },
    });
    check(
      "an upload whose declared type lies is stored as what it really is",
      afterReplace?.imageFormat === "image/jpeg",
      String(afterReplace?.imageFormat),
    );
    check("replacing writes a new key", afterReplace?.imageStorageKey !== firstKey);
    check(
      "and the replaced file is gone from disk, not orphaned",
      firstKey !== null && !(await fileExists(firstKey)),
    );

    const secondKey = afterReplace?.imageStorageKey ?? null;

    for (const [label, bytes, expected] of [
      ["an HTML file named .png", toBytes(Buffer.from(`<html><script>x</script></html>${"y".repeat(400)}`)), 415],
      ["an SVG", toBytes(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"/>${"y".repeat(400)}`)), 415],
      ["an empty file", new Uint8Array(0), 400],
    ] as const) {
      const refused = await upload(imageApi, adminCookie, bytes, "x.png", "image/png");
      check(`${label} is refused`, refused.status === expected, `status ${refused.status}`);
    }

    const oversized = new Uint8Array(6 * 1024 * 1024);
    oversized.set(png.subarray(0, Math.min(png.length, oversized.length)));
    check("a 6MB upload is refused with 413", (await upload(imageApi, adminCookie, oversized)).status === 413);

    check(
      "and none of those refusals disturbed the image already there",
      (
        await prisma.demoWebsite.findUnique({
          where: { leadId: subject.id },
          select: { imageStorageKey: true },
        })
      )?.imageStorageKey === secondKey,
    );

    const served = await fetch(`${BASE_URL}${imageApi}`, {
      headers: { cookie: demoCookie },
      redirect: "manual",
    });
    check("an agent with the module can view the image", served.status === 200, `status ${served.status}`);
    check(
      "served with the sniffed type and nosniff",
      served.headers.get("content-type") === "image/jpeg" &&
        served.headers.get("x-content-type-options") === "nosniff",
      `${served.headers.get("content-type")} / ${served.headers.get("x-content-type-options")}`,
    );
    check("never stored by any cache", (served.headers.get("cache-control") ?? "").includes("no-store"));
    check(
      "and the filename it offers exposes no storage layout",
      !(served.headers.get("content-disposition") ?? "").includes("/"),
    );
    const bytesBack = new Uint8Array(await served.arrayBuffer());
    check(
      "the bytes served are the image that was stored",
      bytesBack.length === jpeg.length && bytesBack[0] === 0xff && bytesBack[1] === 0xd8,
      `${bytesBack.length} bytes`,
    );

    for (const attempt of ["..%2f..%2f..%2fetc%2fpasswd", `${subject.id}%00.png`, "%2e%2e%2fetc"]) {
      const traversal = await get(`/api/leads/${attempt}/demo/image`, adminCookie);
      check(
        `a traversal-shaped lead id (${attempt.slice(0, 22)}) returns no file`,
        traversal.status === 404 || traversal.status === 400,
        `status ${traversal.status}`,
      );
    }

    // An agent *with* the module reaching another lead's image is by design —
    // the module grants the whole pool, exactly as the list does. What must not
    // happen is a stray file coming back for a lead that has none.
    check(
      "changing the id to a lead with no image gets a 404, not a stray file",
      (await get(`/api/leads/${other.id}/demo/image`, bothCookie)).status === 404,
    );

    check(
      "an agent without the module cannot delete an image",
      (await send("DELETE", imageApi, leadsCookie)).status === 403,
    );
    check(
      "…and it is still attached",
      (
        await prisma.demoWebsite.findUnique({
          where: { leadId: subject.id },
          select: { imageStorageKey: true },
        })
      )?.imageStorageKey === secondKey,
    );

    const removed = await send("DELETE", imageApi, bothCookie);
    check("an agent with the module can remove the image", removed.status === 200, `status ${removed.status}`);
    check("the row's image columns are cleared", demoOf(removed)?.image === null);
    check("the file is gone from disk", secondKey !== null && !(await fileExists(secondKey)));
    check("no orphan is reported", removed.body.imageOrphaned === false);
    check("the demo link survived the image removal", demoOf(removed)?.demoUrl === "https://changed-demo.test/x");
    check("and the image endpoint is 404 again", (await get(imageApi, adminCookie)).status === 404);

    // =======================================================================
    section("No duplication — the demo row is metadata, not a record");
    // =======================================================================
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      "select column_name from information_schema.columns where table_name = 'demo_websites'",
    );
    const columnNames = columns.map((row) => row.column_name).sort();
    const forbidden = ["name", "client_name", "phone", "email", "address", "status", "notes", "owner"];
    check(
      "demo_websites holds no copy of any lead field",
      forbidden.every((column) => !columnNames.includes(column)),
      columnNames.join(", "),
    );
    check("demo_websites has a lead_id column", columnNames.includes("lead_id"));

    const fk = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `select count(*)::int as count from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
       where tc.table_name = 'demo_websites' and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'lead_id'`,
    );
    check("lead_id is a foreign key to leads", Number(fk[0]?.count ?? 0) > 0);

    const unique = await prisma.$queryRawUnsafe<{ count: number }[]>(
      "select count(*)::int as count from pg_indexes where tablename = 'demo_websites' and indexdef like '%UNIQUE%lead_id%'",
    );
    check("…and it is UNIQUE, so a lead has at most one demo row", Number(unique[0]?.count ?? 0) > 0);

    check(
      "using Demo Websites created no leads",
      (await prisma.lead.count()) === before.leads,
      `${before.leads} -> ${await prisma.lead.count()}`,
    );
    check(
      "…and exactly one demo row, for the one lead that was given demo data",
      (await prisma.demoWebsite.count()) === before.demoRows + 1,
    );
    check(
      "no duplicate lead was created for the demo view",
      (await prisma.lead.count({ where: { name: { contains: suffix } } })) === 2,
    );

    // Cascade: deleting a lead takes its demo metadata with it.
    const doomed = await prisma.lead.create({
      data: { name: `Cascade Test ${suffix}`, address: "", phone: "0300000000", status: "not_called", notes: "" },
      select: { id: true },
    });
    await send("PATCH", `/api/leads/${doomed.id}/demo`, adminCookie, { demoUrl: "https://cascade.test" });
    check(
      "a demo row exists for the doomed lead",
      (await prisma.demoWebsite.count({ where: { leadId: doomed.id } })) === 1,
    );
    await prisma.lead.delete({ where: { id: doomed.id } });
    check(
      "deleting the lead cascades its demo row away",
      (await prisma.demoWebsite.count({ where: { leadId: doomed.id } })) === 0,
    );

    // =======================================================================
    section("Audio stays in the Leads view and nowhere else");
    // =======================================================================
    check(
      "an agent with New Leads can read call recordings",
      (await get("/api/recordings", leadsCookie)).status === 200,
    );
    check(
      "an agent with Demo Websites only is refused the recordings endpoint",
      (await get("/api/recordings", demoCookie)).status === 403,
    );
    check(
      "…and the recording endpoint for a specific lead",
      (await get(`/api/meetings/${subject.id}/recording`, demoCookie)).status === 403,
    );
    check("recordings are unchanged throughout", (await prisma.meetingRecording.count()) === before.recordings);

    // =======================================================================
    section("The pages, and what the server decided to send");
    // =======================================================================
    const adminDemoPage = await getPage("/demo-websites", adminCookie);
    check("an administrator gets the Demo Websites page", adminDemoPage.status === 200, `status ${adminDemoPage.status}`);
    // Real rows rather than a skeleton or an empty state. Not asserted against
    // a fixture name: the page renders page one of the whole pool in insertion
    // order, and leads created seconds ago are at the far end of it.
    check(
      "…rendered with real lead rows, server-side",
      adminDemoPage.html.includes("row-open-link") && !adminDemoPage.html.includes("No leads here"),
    );
    check(
      "…and the demo columns",
      adminDemoPage.html.includes("Demo image") && adminDemoPage.html.includes("Demo link"),
    );
    check(
      "…and no audio column or audio file input anywhere in the markup",
      !adminDemoPage.html.includes(">Audio<") && !adminDemoPage.html.includes("audio/*"),
    );

    const adminWorklist = await getPage("/", adminCookie);
    check("the worklist still draws its Audio column", adminWorklist.html.includes(">Audio<"), `status ${adminWorklist.status}`);
    check("…and not the demo columns", !adminWorklist.html.includes("Demo image"));

    const demoOnlyPage = await getPage("/demo-websites", demoCookie);
    check("an agent with the module gets the page", demoOnlyPage.status === 200 && demoOnlyPage.html.includes("Demo link"));

    const refusedPage = await getPage("/demo-websites", leadsCookie);
    check("an agent without it gets Access denied", refusedPage.html.includes("Access denied"));
    check("…and no lead reaches their markup", !refusedPage.html.includes(`Renamed Restaurant ${suffix}`));

    const worklistRefused = await getPage("/", demoCookie);
    check(
      "a demo-only agent is not shown the worklist",
      worklistRefused.html.includes("Access denied") ||
        worklistRefused.html.includes('content="1;url=/demo-websites"') ||
        worklistRefused.status === 307,
      `status ${worklistRefused.status}`,
    );

    check("the nav draws Demo Websites for an agent who has it", demoOnlyPage.html.includes("/demo-websites"));
    check("and not for an agent who does not", !refusedPage.html.includes('href="/demo-websites"'));

    // =======================================================================
    section("Permission changes take effect server-side, at once");
    // =======================================================================
    await prisma.user.update({ where: { id: both.id }, data: { canAccessDemoWebsites: false } });
    check(
      "revoking Demo Websites refuses the very next request, with no sign-out",
      (await get(demoList, bothCookie)).status === 403,
    );
    check(
      "…including the demo write endpoints",
      (await send("PATCH", demoApi, bothCookie, { demoUrl: "https://x.test" })).status === 403,
    );
    check("…while New Leads still works for them", (await get(leadList, bothCookie)).status === 200);

    await prisma.user.update({ where: { id: both.id }, data: { canAccessDemoWebsites: true } });
    check("granting it back restores access just as quickly", (await get(demoList, bothCookie)).status === 200);

    await prisma.user.update({
      where: { id: admin.id },
      data: { canAccessLeads: false, canAccessDemoWebsites: false },
    });
    check(
      "an administrator keeps both sections even with both columns false",
      (await get(demoList, adminCookie)).status === 200 && (await get(leadList, adminCookie)).status === 200,
    );
    await prisma.user.update({
      where: { id: admin.id },
      data: { canAccessLeads: true, canAccessDemoWebsites: true },
    });

    // =======================================================================
    section("Nobody can grant themselves a section");
    // =======================================================================
    check(
      "an agent PATCHing their own user row is refused outright",
      (await send("PATCH", `/api/users/${demoOnly.id}`, demoCookie, { canAccessLeads: true })).status === 403,
    );
    check(
      "…and gained nothing",
      (await prisma.user.findUnique({ where: { id: demoOnly.id }, select: { canAccessLeads: true } }))
        ?.canAccessLeads === false,
    );

    const selfEdit = await send("PATCH", `/api/users/${admin.id}`, adminCookie, {
      canAccessDemoWebsites: false,
    });
    check(
      "an administrator cannot edit their own lead access",
      selfEdit.status === 400 && selfEdit.body.error === "self_edit_refused",
      `status ${selfEdit.status}`,
    );

    // The admin panel's Save sends both flags in one PATCH, which is its whole
    // point: an account moves between valid states in a single write, never
    // through "neither section" on the way.
    const bothAtOnce = await send("PATCH", `/api/users/${leadsOnly.id}`, adminCookie, {
      canAccessLeads: false,
      canAccessDemoWebsites: true,
    });
    check("an administrator can swap an agent's sections in one save", bothAtOnce.status === 200, `status ${bothAtOnce.status}`);
    const swapped = await prisma.user.findUnique({
      where: { id: leadsOnly.id },
      select: { canAccessLeads: true, canAccessDemoWebsites: true },
    });
    check(
      "…and both flags moved together",
      swapped?.canAccessLeads === false && swapped?.canAccessDemoWebsites === true,
      JSON.stringify(swapped),
    );
    check("the agent now reads the demo section", (await get(demoList, leadsCookie)).status === 200);
    check("…and is refused the worklist", (await get(leadList, leadsCookie)).status === 403);

    const coerced = await send("PATCH", `/api/users/${leadsOnly.id}`, adminCookie, {
      canAccessLeads: "true",
    });
    check(
      'a string "true" is not a grant',
      (await prisma.user.findUnique({ where: { id: leadsOnly.id }, select: { canAccessLeads: true } }))
        ?.canAccessLeads === false,
      `status ${coerced.status}`,
    );

    // =======================================================================
    section("Cross-site, and the shared filter vocabulary");
    // =======================================================================
    const crossSite = await readReply(
      await fetch(`${BASE_URL}${demoApi}`, {
        method: "PATCH",
        headers: {
          cookie: adminCookie,
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: JSON.stringify({ demoUrl: "https://evil.example" }),
        redirect: "manual",
      }),
    );
    check("a cross-site demo write with a valid admin cookie is refused", crossSite.status === 403, `status ${crossSite.status}`);

    // The demo view uses the lead filters unchanged — same parser, same query.
    const statusFiltered = await get(`${demoCalled}&status=no_answer`, adminCookie);
    check(
      "the lead status filter works in the demo section",
      leadsOf(statusFiltered).length === 1 && leadsOf(statusFiltered)[0]?.id === subject.id,
      `${leadsOf(statusFiltered).length} rows`,
    );

    const searched = await get(
      `/api/leads?section=demo&pageSize=100&q=${encodeURIComponent("Demo Test Dental")}`,
      adminCookie,
    );
    check("the lead search works in the demo section", leadsOf(searched).some((lead) => lead.id === other.id));

    for (const injection of ["' OR 1=1--", "'; DROP TABLE demo_websites; --"]) {
      const attempt = await get(
        `/api/leads?section=demo&pageSize=100&q=${encodeURIComponent(injection)}`,
        adminCookie,
      );
      check(
        `an injection-shaped search (${injection.slice(0, 18)}) matches nothing and does not error`,
        attempt.status === 200 && leadsOf(attempt).length === 0,
        `status ${attempt.status}`,
      );
    }
    check("…and both tables are still there", (await prisma.lead.count()) === before.leads);

    const hugePage = await get("/api/leads?section=demo&pageSize=100000", adminCookie);
    check(
      "?pageSize=100000 is not a way to ask for the whole table in the demo view",
      (hugePage.body.pageSize as number) <= 100,
      `pageSize ${String(hugePage.body.pageSize)}`,
    );

    // =======================================================================
    section("Existing data was not disturbed");
    // =======================================================================
    check("no lead was created or destroyed", (await prisma.lead.count()) === before.leads);
    check("recordings are unchanged", (await prisma.meetingRecording.count()) === before.recordings);
    check(
      "the other fixture lead was never given demo metadata by anything here",
      (await prisma.demoWebsite.count({ where: { leadId: other.id } })) === 0,
    );
  } finally {
    // ---------------------------------------------------------------------
    // Teardown. Runs after a failure too — a test that leaves users, leads
    // and image files behind is a test nobody runs twice.
    // ---------------------------------------------------------------------
    const userIds = [admin.id, both.id, demoOnly.id, leadsOnly.id];

    const leftovers = await prisma.demoWebsite.findMany({
      where: { leadId: { in: [subject.id, other.id] } },
      select: { imageStorageKey: true },
    });
    for (const leftover of leftovers) {
      if (leftover.imageStorageKey) {
        await rm(path.resolve(demoImageRoot(), leftover.imageStorageKey), { force: true }).catch(() => {});
      }
    }

    // The demo rows and the lead activity go with the leads (both cascade).
    await prisma.lead.deleteMany({ where: { name: { contains: suffix } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});

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
