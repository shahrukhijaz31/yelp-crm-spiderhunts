/**
 * Live end-to-end QA suite, against a running server and its database.
 *
 *   . "$TEMP/qa/env.sh" && NODE_ENV=production npx tsx scripts/test-qa-e2e.ts
 *
 * Runs only against a database named `lead_portal_qa` (asserted before
 * anything is touched). Everything it creates carries the run's prefix
 * `qae2e-<stamp>` and is deleted at the end, pass or fail.
 *
 * Sections:
 *   0  real sign-in: password -> emailed code (read from the SMTP sink's log)
 *   1  RBAC sweep over the admin-only APIs, self-promotion, cross-site Origin
 *   2  pagination over 1,800 synthetic leads, with timings
 *   3  filters against an independently computed expected set
 *   4  lead edits: persistence, validation, mass assignment, bad dates
 *   5  XSS / SQL injection
 *   6  CSV import
 *   7  export rows, CSV and XLSX
 *   8  performance metrics against their definitions
 *   9  meeting recordings
 *
 * Assertions state the CORRECT behaviour. Where the app does something else
 * the check fails and says what actually happened.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance as perf } from "node:perf_hooks";

import { PrismaPg } from "@prisma/adapter-pg";
import Papa from "papaparse";
import * as XLSX from "xlsx";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import { conversionRate, type PerformanceMetrics } from "../lib/performanceRules";
import { EXPORT_COLUMN_HEADERS, neutraliseFormula, toExportRows } from "../lib/exportLeads";
import type { Lead } from "../lib/types";

/* -------------------------------------------------------------------------- */
/* Safety: the QA database and nothing else                                   */
/* -------------------------------------------------------------------------- */

const DATABASE_URL = process.env.DATABASE_URL ?? "";
{
  let pathname = "";
  try {
    pathname = new URL(DATABASE_URL).pathname;
  } catch {
    /* fall through */
  }
  if (pathname !== "/lead_portal_qa") {
    console.error(`ABORT: DATABASE_URL must point at /lead_portal_qa (got "${pathname || "unparseable"}").`);
    process.exit(2);
  }
}

const BASE_URL = process.env.TEST_BASE_URL ?? "";
if (!BASE_URL || !/^http:\/\/localhost:3100\/?$/.test(BASE_URL)) {
  console.error(`ABORT: TEST_BASE_URL must be http://localhost:3100 (got "${BASE_URL}").`);
  process.exit(2);
}
const ORIGIN = new URL(BASE_URL).origin;

const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";
const OTP_COOKIE = process.env.NODE_ENV === "production" ? "__Host-lp_otp" : "lp_otp";

const MAIL_LOG = join(process.env.TEMP ?? tmpdir(), "qa", "mail.log");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  log: ["error"],
});

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failures: string[] = [];
const notes: string[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    const line = `  FAIL  ${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(line);
    console.log(line);
  }
  return ok;
}

function info(text: string): void {
  notes.push(text);
  console.log(`  INFO  ${text}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Run identity                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Letters only. The search box also matches phone *digits* when the needle has
 * three or more of them, so a stamp with digits in it would quietly turn every
 * prefix search into a phone search as well.
 */
function letters(n: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  return Array.from(randomBytes(n), (b) => alphabet[b % 26]).join("");
}
const STAMP = letters(8);
const PREFIX = `qae2e-${STAMP}`;
const PASSWORD = "qa-e2e-Pa55phrase-long";
/** Three random digits per run so synthetic phones do not collide across runs. */
const PHONE_BLOCK = String(100 + (randomBytes(2).readUInt16BE(0) % 900));
const UPLOAD_BLOCK = String(100 + ((Number(PHONE_BLOCK) + 457) % 900));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

type Role = "ADMIN" | "AGENT" | "CONTRIBUTOR";
interface TestUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  cookie: string;
}

const createdUserIds = new Set<string>();
let userCounter = 0;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function mintSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + 12 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      userAgent: "qa-e2e",
      ipAddress: "127.0.0.1",
    },
  });
  return `${SESSION_COOKIE}=${token}`;
}

let cachedHash: string | null = null;
async function createUser(role: Role, label: string): Promise<TestUser> {
  userCounter += 1;
  const username = `${PREFIX}-${label}-${userCounter}`;
  const email = `${username}@example.invalid`;
  cachedHash ??= await hashPassword(PASSWORD);
  const user = await prisma.user.create({
    data: {
      name: `QA E2E ${label} ${STAMP}`,
      username,
      email,
      passwordHash: cachedHash,
      role,
      isActive: true,
    },
    select: { id: true },
  });
  createdUserIds.add(user.id);
  return { id: user.id, username, email, role, cookie: await mintSession(user.id) };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

interface CallOptions {
  method?: string;
  cookie?: string;
  json?: unknown;
  body?: BodyInit;
  origin?: string | null;
  headers?: Record<string, string>;
}

interface CallResult {
  status: number;
  ms: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary JSON bodies, inspected field by field
  json: any;
  headers: Headers;
}

async function call(path: string, options: CallOptions = {}): Promise<CallResult> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  const stateChanging = method !== "GET" && method !== "HEAD";
  if (stateChanging && options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN;
    headers["sec-fetch-site"] = (options.origin ?? ORIGIN) === ORIGIN ? "same-origin" : "cross-site";
  }
  let body = options.body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const start = perf.now();
  const response = await fetch(`${BASE_URL}${path}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  const ms = perf.now() - start;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see CallResult.json
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, ms, text, json, headers: response.headers };
}

/**
 * A pool of agents for searches. `GET /api/leads?q=` is limited to 120 a
 * minute per user (lib/rateLimit.ts), and walking 1,800 rows ten at a time is
 * 180 searches — so the walk hands off to a fresh agent before the limit.
 */
class SearchPool {
  private current: TestUser | null = null;
  private used = 0;
  constructor(private readonly label: string) {}
  async user(): Promise<TestUser> {
    if (!this.current || this.used >= 100) {
      this.current = await createUser("AGENT", this.label);
      this.used = 0;
    }
    this.used += 1;
    return this.current;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sameSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function setDiff(a: Iterable<string>, b: Iterable<string>): string {
  const right = new Set(b);
  const left = new Set(a);
  const missing = [...left].filter((x) => !right.has(x)).length;
  const extra = [...right].filter((x) => !left.has(x)).length;
  return `expected ${left.size}, got ${right.size} (missing ${missing}, extra ${extra})`;
}

/** Walk every page of a `GET /api/leads` query and return the ids, in order. */
async function walk(
  pool: SearchPool | TestUser,
  params: Record<string, string | string[]>,
  pageSize: number,
): Promise<{ ids: string[]; total: number; pages: number; times: number[]; statuses: number[] }> {
  const ids: string[] = [];
  const times: number[] = [];
  const statuses: number[] = [];
  let total = -1;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
    }
    search.set("page", String(page));
    search.set("pageSize", String(pageSize));
    const user = pool instanceof SearchPool ? await pool.user() : pool;
    const res = await call(`/api/leads?${search}`, { cookie: user.cookie });
    times.push(res.ms);
    statuses.push(res.status);
    if (res.status !== 200) break;
    total = res.json.total;
    totalPages = res.json.totalPages;
    for (const lead of res.json.leads as { id: string }[]) ids.push(lead.id);
    if (page > 400) break; // a runaway pager is a bug, not a reason to hang
  }
  return { ids, total, pages: totalPages, times, statuses };
}

/* -------------------------------------------------------------------------- */
/* Mail                                                                       */
/* -------------------------------------------------------------------------- */

function decodeQuotedPrintable(input: string): string {
  const soft = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i += 1) {
    const ch = soft[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Every decoded body of one raw message (all MIME leaves, plus the raw text). */
function decodeMessage(raw: string): string[] {
  // The sink stores the DATA stream as-is, so undo SMTP dot-stuffing first.
  const message = raw.split("\n").map((line) => (line.startsWith("..") ? line.slice(1) : line)).join("\n");
  const out: string[] = [message];
  const boundaries = [...message.matchAll(/boundary="?([^";\s]+)"?/gi)].map((m) => m[1]!);
  const parts = boundaries.length
    ? boundaries.flatMap((b) => message.split(`--${b}`))
    : [message];
  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).replace(/^\r?\n\r?\n/, "");
    const cte = /content-transfer-encoding:\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
    if (cte === "quoted-printable") out.push(decodeQuotedPrintable(body));
    else if (cte === "base64") out.push(Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"));
    else out.push(body);
  }
  return out;
}

function readLatestOtp(email: string): string | null {
  if (!existsSync(MAIL_LOG)) return null;
  const messages = readFileSync(MAIL_LOG, "utf8").split("=====END=====");
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i]!;
    if (!raw.toLowerCase().includes(email.toLowerCase())) continue;
    for (const text of decodeMessage(raw)) {
      const plain = /verification code is:\s*(\d{6})\b/i.exec(text);
      if (plain) return plain[1]!;
      const html = /letter-spacing:0\.32em;[^>]*>\s*(\d{6})\s*</i.exec(text);
      if (html) return html[1]!;
    }
  }
  return null;
}

function cookieFrom(headers: Headers, name: string): string | null {
  for (const line of headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq).trim() === name) return pair!.slice(eq + 1);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Shared state                                                               */
/* -------------------------------------------------------------------------- */

interface Synthetic {
  id: string;
  index: number; // 1-based
  name: string;
  phone: string;
  digits: string;
  source: "yelp" | "google";
  status: string;
  called: boolean;
}
const synthetic: Synthetic[] = [];
const recordingLeadIds = new Set<string>();

/* ========================================================================== */
/* 0  Real sign-in through the emailed code                                   */
/* ========================================================================== */

async function s0Login(): Promise<void> {
  section("0  Sign-in: password -> emailed code -> session");

  const user = await createUser("ADMIN", "login");
  // createUser mints a session for convenience; this test wants none.
  await prisma.session.deleteMany({ where: { userId: user.id } });

  // One wrong password: well under the 8-per-15-minutes IP window.
  const wrong = await call("/api/auth/login", {
    method: "POST",
    origin: null,
    json: { username: user.username, password: "definitely-wrong-password" },
  });
  check("a wrong password is refused with 401", wrong.status === 401, `status ${wrong.status}`);

  const login = await call("/api/auth/login", {
    method: "POST",
    origin: null,
    json: { username: user.username, password: PASSWORD },
  });
  if (!check("the right password answers 200 with otpRequired", login.status === 200 && login.json?.otpRequired === true, `status ${login.status} ${login.text.slice(0, 120)}`)) {
    return;
  }
  check("the password alone mints no session", (await prisma.session.count({ where: { userId: user.id } })) === 0);

  const otpToken = cookieFrom(login.headers, OTP_COOKIE);
  check(`the challenge cookie ${OTP_COOKIE} is set`, otpToken !== null);
  const otpCookie = `${OTP_COOKIE}=${otpToken}`;

  let code: string | null = null;
  for (let attempt = 0; attempt < 20 && !code; attempt += 1) {
    code = readLatestOtp(user.email);
    if (!code) await new Promise((r) => setTimeout(r, 250));
  }
  if (!check("a 6-digit code arrived in the mail sink for this user", code !== null && /^\d{6}$/.test(code))) return;

  check("the code is not in the login response body", !login.text.includes(code!));
  check("the code is not in any login response header", ![...login.headers.values()].some((v) => v.includes(code!)));

  const wrongCode = code === "000000" ? "111111" : "000000";
  const bad = await call("/api/auth/otp/verify", {
    method: "POST",
    origin: null,
    cookie: otpCookie,
    json: { code: wrongCode },
  });
  check(
    "a wrong code is refused (400 invalid_code, attempts counted down)",
    bad.status === 400 && bad.json?.error === "invalid_code" && bad.json?.attemptsRemaining === 4,
    `status ${bad.status} ${bad.text.slice(0, 120)}`,
  );
  check("a wrong code issues no session cookie", cookieFrom(bad.headers, SESSION_COOKIE) === null);
  check("the code is not in the wrong-code response", !bad.text.includes(code!));

  const good = await call("/api/auth/otp/verify", {
    method: "POST",
    origin: null,
    cookie: otpCookie,
    json: { code },
  });
  const sessionToken = cookieFrom(good.headers, SESSION_COOKIE);
  check("the right code answers 200 ok", good.status === 200 && good.json?.ok === true, `status ${good.status} ${good.text.slice(0, 120)}`);
  check(`a ${SESSION_COOKIE} cookie is issued`, Boolean(sessionToken));
  check("the code is not in the verify response body", !good.text.includes(code!));
  check("exactly one session row now exists for the user", (await prisma.session.count({ where: { userId: user.id } })) === 1);

  if (sessionToken) {
    const home = await call("/", { cookie: `${SESSION_COOKIE}=${sessionToken}` });
    const location = home.headers.get("location") ?? "";
    check(
      "/ loads with the new session (200, not a bounce to /login)",
      home.status === 200 && !location.includes("/login"),
      `status ${home.status} location=${location}`,
    );
  }

  const reused = await call("/api/auth/otp/verify", {
    method: "POST",
    origin: null,
    cookie: otpCookie,
    json: { code },
  });
  check(
    "re-using the same code is refused and mints nothing",
    reused.status !== 200 && cookieFrom(reused.headers, SESSION_COOKIE) === null,
    `status ${reused.status} ${reused.text.slice(0, 120)}`,
  );
  check("still exactly one session row after the replay", (await prisma.session.count({ where: { userId: user.id } })) === 1);
}

/* ========================================================================== */
/* 1  RBAC                                                                    */
/* ========================================================================== */

async function s1Rbac(admin: TestUser, agent: TestUser, contributor: TestUser): Promise<void> {
  section("1  RBAC sweep over admin-only APIs");

  const victim = await createUser("AGENT", "rbacvictim");

  interface Probe {
    method: string;
    path: string;
    json?: unknown;
    form?: () => FormData;
    adminCheck: boolean; // whether admin is also exercised here for 2xx
  }
  const csvForm = () => {
    const form = new FormData();
    form.append("file", new File(["name,phone\n"], `${PREFIX}-rbac.csv`, { type: "text/csv" }));
    return form;
  };
  const probes: Probe[] = [
    { method: "GET", path: "/api/reports/app-usage", adminCheck: true },
    { method: "GET", path: `/api/reports/app-usage/timeline?agent=${victim.id}`, adminCheck: true },
    { method: "GET", path: "/api/reports/productivity", adminCheck: true },
    { method: "GET", path: `/api/reports/productivity/${victim.id}`, adminCheck: true },
    { method: "GET", path: "/api/reports/productivity/config", adminCheck: true },
    { method: "PUT", path: "/api/reports/productivity/config", json: {}, adminCheck: false },
    { method: "GET", path: "/api/reports/team?range=today", adminCheck: true },
    { method: "GET", path: "/api/reports/time", adminCheck: true },
    { method: "GET", path: `/api/reports/time/${victim.id}`, adminCheck: true },
    { method: "GET", path: "/api/reports/timesheets", adminCheck: true },
    { method: "GET", path: "/api/reports/work-location", adminCheck: true },
    { method: "GET", path: "/api/users", adminCheck: true },
    {
      method: "POST",
      path: "/api/users",
      json: { name: "x", username: `${PREFIX}-rbac-shouldnot`, email: `${PREFIX}-rbac-shouldnot@example.invalid`, password: PASSWORD, role: "ADMIN" },
      adminCheck: false,
    },
    { method: "PATCH", path: `/api/users/${victim.id}`, json: { name: "renamed by non-admin" }, adminCheck: false },
    { method: "DELETE", path: `/api/users/${victim.id}`, adminCheck: false },
    { method: "POST", path: `/api/users/${victim.id}/password-reset`, json: {}, adminCheck: false },
    { method: "GET", path: "/api/time-adjustments", adminCheck: true },
    { method: "POST", path: "/api/time-adjustments", json: { workSessionId: "nope" }, adminCheck: false },
    { method: "GET", path: "/api/screenshots", adminCheck: true },
    { method: "DELETE", path: "/api/admin/screenshots", json: { ids: [`${STAMP}nonexistent`] }, adminCheck: true },
    { method: "DELETE", path: `/api/admin/screenshots/${STAMP}nonexistent`, adminCheck: false },
    { method: "POST", path: "/api/leads/upload", form: csvForm, adminCheck: false },
  ];

  for (const probe of probes) {
    const make = (cookie?: string): CallOptions => ({
      method: probe.method,
      cookie,
      json: probe.json,
      body: probe.form ? probe.form() : undefined,
    });
    const anon = await call(probe.path, make());
    const asAgent = await call(probe.path, make(agent.cookie));
    const asContrib = await call(probe.path, make(contributor.cookie));
    check(`${probe.method} ${probe.path.split("?")[0]} anonymous -> 401`, anon.status === 401, `status ${anon.status}`);
    check(`${probe.method} ${probe.path.split("?")[0]} AGENT -> 403`, asAgent.status === 403, `status ${asAgent.status}`);
    check(`${probe.method} ${probe.path.split("?")[0]} CONTRIBUTOR -> 403`, asContrib.status === 403, `status ${asContrib.status}`);
    if (probe.adminCheck) {
      const asAdmin = await call(probe.path, make(admin.cookie));
      check(
        `${probe.method} ${probe.path.split("?")[0]} ADMIN -> 2xx`,
        asAdmin.status >= 200 && asAdmin.status < 300,
        `status ${asAdmin.status} ${asAdmin.text.slice(0, 120)}`,
      );
    }
  }
  check(
    "no user was created by the refused POST /api/users",
    (await prisma.user.count({ where: { username: `${PREFIX}-rbac-shouldnot` } })) === 0,
  );
  const victimRow = await prisma.user.findUnique({ where: { id: victim.id }, select: { name: true } });
  check("the refused PATCH /api/users/:id changed nothing", victimRow?.name !== "renamed by non-admin");

  // Admin round-trip on the user endpoints: create, edit, delete a throwaway.
  const created = await call("/api/users", {
    method: "POST",
    cookie: admin.cookie,
    json: {
      name: `QA E2E created ${STAMP}`,
      username: `${PREFIX}-apicreated`,
      email: `${PREFIX}-apicreated@example.invalid`,
      password: PASSWORD,
      role: "AGENT",
    },
  });
  const createdId: string | undefined = created.json?.user?.id;
  if (createdId) createdUserIds.add(createdId);
  check("POST /api/users ADMIN -> 201", created.status === 201 && Boolean(createdId), `status ${created.status} ${created.text.slice(0, 160)}`);
  if (createdId) {
    const patched = await call(`/api/users/${createdId}`, { method: "PATCH", cookie: admin.cookie, json: { name: `QA E2E patched ${STAMP}` } });
    check("PATCH /api/users/:id ADMIN -> 200", patched.status === 200, `status ${patched.status} ${patched.text.slice(0, 120)}`);
    const reset = await call(`/api/users/${createdId}/password-reset`, { method: "POST", cookie: admin.cookie, json: {} });
    check("POST /api/users/:id/password-reset ADMIN -> 2xx", reset.status >= 200 && reset.status < 300, `status ${reset.status} ${reset.text.slice(0, 120)}`);
    const deleted = await call(`/api/users/${createdId}`, { method: "DELETE", cookie: admin.cookie });
    check("DELETE /api/users/:id ADMIN -> 200", deleted.status === 200, `status ${deleted.status} ${deleted.text.slice(0, 120)}`);
    if (deleted.status === 200) createdUserIds.delete(createdId);
  }

  // Self-promotion.
  const promote = await call(`/api/users/${agent.id}`, { method: "PATCH", cookie: agent.cookie, json: { role: "ADMIN" } });
  const agentRow = await prisma.user.findUnique({ where: { id: agent.id }, select: { role: true } });
  check("an AGENT cannot PATCH their own role (403)", promote.status === 403, `status ${promote.status}`);
  check("…and the role in the database is still AGENT", agentRow?.role === "AGENT", `role ${agentRow?.role}`);
  const cPromote = await call(`/api/users/${contributor.id}`, { method: "PATCH", cookie: contributor.cookie, json: { role: "ADMIN" } });
  check("a CONTRIBUTOR cannot PATCH their own role (403)", cPromote.status === 403, `status ${cPromote.status}`);

  // Cross-site Origin on state-changing requests.
  const crossUser = await call("/api/users", {
    method: "POST",
    cookie: admin.cookie,
    origin: "https://evil.example",
    json: { name: "x", username: `${PREFIX}-csrf`, email: `${PREFIX}-csrf@example.invalid`, password: PASSWORD, role: "ADMIN" },
  });
  check(
    "a cross-site POST /api/users with an admin cookie is refused (403 cross_site_request)",
    crossUser.status === 403 && crossUser.json?.error === "cross_site_request",
    `status ${crossUser.status} ${crossUser.text.slice(0, 120)}`,
  );
  check("…and created no user", (await prisma.user.count({ where: { username: `${PREFIX}-csrf` } })) === 0);
  const crossOriginOnly = await call(`/api/users/${victim.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    origin: null,
    headers: { origin: "https://evil.example" },
    json: { name: "csrf-renamed" },
  });
  check(
    "a PATCH with a foreign Origin and no Sec-Fetch-Site is refused (403)",
    crossOriginOnly.status === 403,
    `status ${crossOriginOnly.status}`,
  );
  const nullOrigin = await call(`/api/users/${victim.id}`, {
    method: "PATCH",
    cookie: admin.cookie,
    origin: null,
    headers: { origin: "null" },
    json: { name: "csrf-renamed" },
  });
  check("a PATCH with Origin: null is refused (403)", nullOrigin.status === 403, `status ${nullOrigin.status}`);
  const after = await prisma.user.findUnique({ where: { id: victim.id }, select: { name: true } });
  check("…and the user was not renamed", after?.name !== "csrf-renamed");
}

/* ========================================================================== */
/* 2  Pagination at scale                                                     */
/* ========================================================================== */

const SYNTHETIC_COUNT = 1800;
const timings: Record<string, { median: number; max: number; n: number }> = {};

async function s2Pagination(contributor: TestUser): Promise<void> {
  section(`2  Pagination over ${SYNTHETIC_COUNT} synthetic leads`);

  const rows = Array.from({ length: SYNTHETIC_COUNT }, (_, i) => {
    const index = i + 1;
    const n = String(index).padStart(4, "0");
    const digits = `555${PHONE_BLOCK}${n}`;
    return {
      name: `QA Lead ${n} ${PREFIX}`,
      phone: `(555) ${PHONE_BLOCK}-${n}`,
      address: `${index} Test Street, Springfield`,
      source: (index % 3 === 0 ? "google" : "yelp") as "yelp" | "google",
      createdById: contributor.id,
      _digits: digits,
      _index: index,
    };
  });
  const insertStart = perf.now();
  await prisma.lead.createMany({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped bookkeeping fields
    data: rows.map(({ _digits, _index, ...data }) => data),
  });
  info(`createMany of ${SYNTHETIC_COUNT} leads took ${(perf.now() - insertStart).toFixed(0)} ms`);

  const stored = await prisma.lead.findMany({
    where: { name: { contains: PREFIX }, createdById: contributor.id },
    select: { id: true, name: true, phone: true, source: true },
  });
  check(`${SYNTHETIC_COUNT} synthetic leads exist in the database`, stored.length === SYNTHETIC_COUNT, `found ${stored.length}`);
  const byName = new Map(stored.map((row) => [row.name, row]));
  for (const row of rows) {
    const db = byName.get(row.name);
    if (!db) continue;
    synthetic.push({
      id: db.id,
      index: row._index,
      name: row.name,
      phone: row.phone,
      digits: row._digits,
      source: row.source,
      status: "not_called",
      called: false,
    });
  }
  const allIds = synthetic.map((s) => s.id);

  for (const pageSize of [10, 20, 50]) {
    const pool = new SearchPool(`page${pageSize}`);
    const result = await walk(pool, { work: "all", q: PREFIX }, pageSize);
    const nonOk = result.statuses.filter((s) => s !== 200);
    check(`pageSize ${pageSize}: every page answered 200`, nonOk.length === 0, `non-200: ${[...new Set(nonOk)].join(",")}`);
    check(`pageSize ${pageSize}: total is ${SYNTHETIC_COUNT}`, result.total === SYNTHETIC_COUNT, `total ${result.total}`);
    check(
      `pageSize ${pageSize}: walked ${Math.ceil(SYNTHETIC_COUNT / pageSize)} pages`,
      result.pages === Math.ceil(SYNTHETIC_COUNT / pageSize),
      `totalPages ${result.pages}`,
    );
    check(`pageSize ${pageSize}: no id appears on two pages`, new Set(result.ids).size === result.ids.length, `${result.ids.length - new Set(result.ids).size} duplicates`);
    check(`pageSize ${pageSize}: union of pages == the ${SYNTHETIC_COUNT} created`, sameSet(allIds, result.ids), setDiff(allIds, result.ids));
    timings[`search walk pageSize=${pageSize}`] = { median: median(result.times), max: Math.max(...result.times), n: result.times.length };

    // Out of range: clamped to the last page.
    const user = await pool.user();
    const far = await call(`/api/leads?work=all&q=${encodeURIComponent(PREFIX)}&page=99999&pageSize=${pageSize}`, { cookie: user.cookie });
    const lastPage = Math.ceil(SYNTHETIC_COUNT / pageSize);
    const lastIds = result.ids.slice((lastPage - 1) * pageSize);
    check(
      `pageSize ${pageSize}: page=99999 is clamped to page ${lastPage} with the last page's rows`,
      far.status === 200 && far.json?.page === lastPage && sameSet(lastIds, (far.json?.leads ?? []).map((l: { id: string }) => l.id)),
      `status ${far.status} page ${far.json?.page}`,
    );
  }

  // Non-numeric and negative pages fall back to 1; an unsupported pageSize to 20.
  const pool = new SearchPool("pageodd");
  const odd = await call(`/api/leads?work=all&q=${encodeURIComponent(PREFIX)}&page=-5&pageSize=100000`, { cookie: (await pool.user()).cookie });
  check(
    "page=-5&pageSize=100000 answers page 1 at the default 20 rows",
    odd.status === 200 && odd.json?.page === 1 && odd.json?.pageSize === 20 && odd.json?.leads?.length === 20,
    `status ${odd.status} page ${odd.json?.page} pageSize ${odd.json?.pageSize}`,
  );

  // The contributor's scope is exactly these rows: the same walk with no search.
  const scoped = await walk(contributor, { work: "all" }, 100);
  check(
    "a contributor's unsearched list (pageSize 100) is exactly their 1,800 leads",
    scoped.total === SYNTHETIC_COUNT && sameSet(allIds, scoped.ids) && new Set(scoped.ids).size === scoped.ids.length,
    setDiff(allIds, scoped.ids),
  );
  timings["unsearched walk pageSize=100 (contributor scope)"] = { median: median(scoped.times), max: Math.max(...scoped.times), n: scoped.times.length };
}

/* ========================================================================== */
/* 3  Filters                                                                 */
/* ========================================================================== */

async function s3Filters(agent: TestUser): Promise<void> {
  section("3  Filters against an independently computed expected set");

  // Statuses, set directly: 1-120 interested, 121-200 no_answer, 201-230
  // not_interested. Lead 231 is set through the real PATCH below.
  const plan: Array<[number, number, string]> = [
    [1, 120, "interested"],
    [121, 200, "no_answer"],
    [201, 230, "not_interested"],
  ];
  for (const [from, to, status] of plan) {
    const ids = synthetic.filter((s) => s.index >= from && s.index <= to).map((s) => s.id);
    await prisma.lead.updateMany({
      where: { id: { in: ids } },
      data: { status: status as never, firstCalledAt: new Date() },
    });
    for (const s of synthetic) if (s.index >= from && s.index <= to) {
      s.status = status;
      s.called = true;
    }
  }
  const viaApi = synthetic.find((s) => s.index === 231)!;
  const patched = await call(`/api/leads/${viaApi.id}`, { method: "PATCH", cookie: agent.cookie, json: { status: "voicemail" } });
  check("PATCH status=voicemail as an agent -> 200", patched.status === 200, `status ${patched.status} ${patched.text.slice(0, 120)}`);
  viaApi.status = "voicemail";
  viaApi.called = true;
  const firstCalled = await prisma.lead.findUnique({ where: { id: viaApi.id }, select: { firstCalledAt: true } });
  check("…which stamps first_called_at (moves it to Called)", firstCalled?.firstCalledAt !== null);

  const pool = new SearchPool("filters");
  const cases: Array<{ label: string; params: Record<string, string | string[]>; expect: (s: Synthetic) => boolean }> = [
    { label: "work=called", params: { work: "called", q: PREFIX }, expect: (s) => s.called },
    { label: "work=new", params: { work: "new", q: PREFIX }, expect: (s) => !s.called },
    { label: "status=interested", params: { work: "all", q: PREFIX, status: "interested" }, expect: (s) => s.status === "interested" },
    {
      label: "status=no_answer+voicemail",
      params: { work: "all", q: PREFIX, status: ["no_answer", "voicemail"] },
      expect: (s) => s.status === "no_answer" || s.status === "voicemail",
    },
    { label: "source=google", params: { work: "all", q: PREFIX, source: "google" }, expect: (s) => s.source === "google" },
    {
      label: "work=called + status=interested + source=google",
      params: { work: "called", q: PREFIX, status: "interested", source: "google" },
      expect: (s) => s.called && s.status === "interested" && s.source === "google",
    },
    {
      label: "work=new + source=yelp",
      params: { work: "new", q: PREFIX, source: "yelp" },
      expect: (s) => !s.called && s.source === "yelp",
    },
    {
      label: "unknown status value is dropped, not queried",
      params: { work: "all", q: PREFIX, status: "bogus" },
      expect: () => true,
    },
  ];
  for (const c of cases) {
    const result = await walk(pool, c.params, 100);
    const expected = synthetic.filter(c.expect).map((s) => s.id);
    check(
      `filter ${c.label}: ${expected.length} expected rows, exactly`,
      result.total === expected.length && sameSet(expected, result.ids),
      `${setDiff(expected, result.ids)} total=${result.total}`,
    );
  }

  // Search by name and by phone digits, no prefix to lean on.
  const target = synthetic.find((s) => s.index === 42)!;
  const searches: Array<{ label: string; q: string; expect: string[] }> = [
    { label: "full unique name", q: target.name, expect: [target.id] },
    { label: "name, different case", q: target.name.toUpperCase(), expect: [target.id] },
    { label: "phone digits only", q: target.digits, expect: [target.id] },
    { label: "phone as formatted", q: target.phone, expect: [target.id] },
    {
      label: "partial phone digits (10 leads 0040-0049)",
      q: `555${PHONE_BLOCK}004`,
      expect: synthetic.filter((s) => s.index >= 40 && s.index <= 49).map((s) => s.id),
    },
  ];
  for (const s of searches) {
    const result = await walk(pool, { work: "all", q: s.q }, 100);
    check(`search ${s.label}`, sameSet(s.expect, result.ids), `${setDiff(s.expect, result.ids)} q=${s.q}`);
  }
}

/* ========================================================================== */
/* 4  Lead edits                                                              */
/* ========================================================================== */

async function s4Edits(agent: TestUser): Promise<void> {
  section("4  Lead edits");

  const lead = synthetic.find((s) => s.index === 500)!;
  const path = `/api/leads/${lead.id}`;

  const saved = await call(path, { method: "PATCH", cookie: agent.cookie, json: { status: "owner_not_available", notes: `Rang ${STAMP}` } });
  check("PATCH status+notes -> 200", saved.status === 200, `status ${saved.status} ${saved.text.slice(0, 120)}`);
  const reread = await call(path, { cookie: agent.cookie });
  check(
    "re-GET shows the saved status and notes",
    reread.json?.detail?.lead?.status === "owner_not_available" && reread.json?.detail?.lead?.notes === `Rang ${STAMP}`,
    `status=${reread.json?.detail?.lead?.status} notes=${reread.json?.detail?.lead?.notes}`,
  );

  const empty = await call(path, { method: "PATCH", cookie: agent.cookie, json: { notes: "" } });
  const emptyRow = await prisma.lead.findUnique({ where: { id: lead.id }, select: { notes: true } });
  check("empty notes are accepted and stored as \"\"", empty.status === 200 && emptyRow?.notes === "", `status ${empty.status}`);

  const huge = "N".repeat(100_000);
  const big = await call(path, { method: "PATCH", cookie: agent.cookie, json: { notes: huge } });
  const bigRow = await prisma.lead.findUnique({ where: { id: lead.id }, select: { notes: true } });
  info(`100,000-char notes: PATCH -> ${big.status}, stored length ${bigRow?.notes.length}, response ${big.text.length} bytes, ${big.ms.toFixed(0)} ms`);
  check(
    "100,000-char notes are refused with 400 (no length cap means unbounded rows and history)",
    big.status === 400,
    `PATCH -> ${big.status}, stored ${bigRow?.notes.length} chars`,
  );
  await prisma.lead.update({ where: { id: lead.id }, data: { notes: "" } });

  const invalid = await call(path, { method: "PATCH", cookie: agent.cookie, json: { status: "bogus" } });
  check("invalid status -> 400", invalid.status === 400, `status ${invalid.status}`);
  const notString = await call(path, { method: "PATCH", cookie: agent.cookie, json: { notes: 42 } });
  check("non-string notes -> 400", notString.status === 400, `status ${notString.status}`);
  const notJson = await call(path, { method: "PATCH", cookie: agent.cookie, body: "{not json", headers: { "content-type": "application/json" } });
  check("malformed JSON -> 400", notJson.status === 400, `status ${notJson.status}`);

  const before = await prisma.lead.findUnique({ where: { id: lead.id } });
  const otherUser = await createUser("AGENT", "massassign");
  const mass = await call(path, {
    method: "PATCH",
    cookie: agent.cookie,
    json: {
      notes: `mass ${STAMP}`,
      id: "hijacked-id",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      firstCalledAt: "2000-01-01T00:00:00.000Z",
      createdById: otherUser.id,
      sourceBatch: "hijack",
      name: "Renamed by agent",
      phone: "+1 999 999 9999",
      categories: ["hijack"],
      rating: 1,
    },
  });
  const afterMass = await prisma.lead.findUnique({ where: { id: lead.id } });
  check("a body with unknown/protected fields still answers 200 for the allowed one", mass.status === 200 && afterMass?.notes === `mass ${STAMP}`, `status ${mass.status}`);
  check(
    "id, createdAt, firstCalledAt, createdById, sourceBatch are untouched",
    afterMass !== null &&
      afterMass.id === lead.id &&
      afterMass.createdAt.getTime() === before!.createdAt.getTime() &&
      afterMass.firstCalledAt?.getTime() === before!.firstCalledAt?.getTime() &&
      afterMass.createdById === before!.createdById &&
      afterMass.sourceBatch === before!.sourceBatch,
  );
  check(
    "an AGENT's name/phone/categories/rating in the body are ignored",
    afterMass?.name === before!.name && afterMass?.phone === before!.phone && afterMass?.rating === before!.rating && afterMass?.categories.length === 0,
  );

  await prisma.lead.update({ where: { id: lead.id }, data: { callbackDate: new Date("2026-11-20T00:00:00.000Z") } });
  for (const bad of ["2026-13-01", "2026-02-30"]) {
    const res = await call(path, { method: "PATCH", cookie: agent.cookie, json: { callbackDate: bad } });
    const row = await prisma.lead.findUnique({ where: { id: lead.id }, select: { callbackDate: true } });
    const stored = row?.callbackDate ? row.callbackDate.toISOString().slice(0, 10) : "null";
    info(`callbackDate "${bad}": PATCH -> ${res.status}, stored callback_date=${stored}`);
    check(`callbackDate "${bad}" is refused with 400`, res.status === 400, `PATCH -> ${res.status}, stored callback_date=${stored}`);
    await prisma.lead.update({ where: { id: lead.id }, data: { callbackDate: new Date("2026-11-20T00:00:00.000Z") } });
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { callbackDate: null } });

  for (const bad of ["2026-02-30", "2026-13-01"]) {
    const res = await call(`/api/leads?work=all&callback=custom&callbackFrom=${bad}`, { cookie: agent.cookie });
    info(`GET /api/leads?callback=custom&callbackFrom=${bad} -> ${res.status} ${res.json?.error ?? ""}`);
    check(
      `GET ?callback=custom&callbackFrom=${bad} does not fail with a 5xx (expect 400 or the bound ignored)`,
      res.status < 500,
      `status ${res.status} ${res.json?.error ?? ""}`,
    );
  }

  const unknown = await call(`/api/leads/${PREFIX}-does-not-exist`, { method: "PATCH", cookie: agent.cookie, json: { notes: "x" } });
  check("PATCH an unknown lead id -> 404", unknown.status === 404, `status ${unknown.status}`);
}

/* ========================================================================== */
/* 5  XSS / SQLi                                                              */
/* ========================================================================== */

async function s5Injection(admin: TestUser): Promise<void> {
  section("5  XSS and SQL injection");

  const xssName = `<script>alert(1)</script> ${PREFIX}`;
  const sqlName = `' OR 1=1-- ${PREFIX}`;
  const created: Record<string, string> = {};
  for (const [label, name, phone, website] of [
    ["xss", xssName, `+1 555 ${PHONE_BLOCK} 9901`, "javascript:alert(1)"],
    ["sql", sqlName, `+1 555 ${PHONE_BLOCK} 9902`, "JaVaScRiPt:alert(document.cookie)"],
  ] as const) {
    const res = await call("/api/leads", { method: "POST", cookie: admin.cookie, json: { name, phone, website, source: "google" } });
    check(`POST /api/leads with a ${label} name -> 201`, res.status === 201, `status ${res.status} ${res.text.slice(0, 160)}`);
    if (res.json?.lead?.id) created[label] = res.json.lead.id;
  }
  for (const [label, name] of [["xss", xssName], ["sql", sqlName]] as const) {
    const id = created[label];
    if (!id) continue;
    const res = await call(`/api/leads/${id}`, { cookie: admin.cookie });
    check(`the ${label} name is stored and returned verbatim`, res.json?.detail?.lead?.name === name, `got ${JSON.stringify(res.json?.detail?.lead?.name)}`);
  }

  const leadsBefore = await prisma.lead.count();
  const pool = new SearchPool("inject");
  const needles = [
    "' OR 1=1--",
    "' OR '1'='1",
    `${PREFIX}' OR '1'='1`,
    "'; DROP TABLE leads;--",
    "%",
    "_",
    "\\",
    `${PREFIX}%`,
    "<script>alert(1)</script>",
  ];
  for (const needle of needles) {
    const user = await pool.user();
    const res = await call(`/api/leads?work=all&pageSize=100&q=${encodeURIComponent(needle)}`, { cookie: user.cookie });
    const rows: Lead[] = res.json?.leads ?? [];
    const lower = needle.trim().toLowerCase();
    // The documented second arm: a needle with 3+ digits also matches phones
    // by digits (lib/leadDb.ts leadFilterSql), e.g. "…'1'='1" -> "11…".
    const digits = lower.replace(/\D/g, "");
    const legit = (l: Lead) =>
      `${l.name} ${l.address} ${l.owner ?? ""} ${l.notes}`.toLowerCase().includes(lower) ||
      (digits.length >= 3 && (l.phone ?? "").replace(/\D/g, "").includes(digits));
    check(
      `search ${JSON.stringify(needle)} -> 200 and only rows literally containing it (${res.json?.total ?? "?"} total)`,
      res.status === 200 && rows.every(legit),
      `status ${res.status}, ${rows.filter((l) => !legit(l)).length} rows matching neither the text nor the phone digits`,
    );
  }
  check("the leads table is intact after the injection searches", (await prisma.lead.count()) === leadsBefore);

  for (const [label, id] of Object.entries(created)) {
    const page = await call(`/leads/${id}`, { cookie: admin.cookie });
    check(`/leads/<${label} lead> renders (200)`, page.status === 200, `status ${page.status}`);
    const html = page.text;
    check(
      `/leads/<${label} lead> has no javascript: href`,
      !/href\s*=\s*["']?\s*javascript:/i.test(html),
      "found href=\"javascript:...\"",
    );
    check(`/leads/<${label} lead> has no unescaped <script>alert(1)</script>`, !html.includes("<script>alert(1)</script>"));
  }
}

/* ========================================================================== */
/* 6  CSV import                                                              */
/* ========================================================================== */

const uploadedPhones: string[] = [];

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function csv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
let uploadSeq = 0;
function uploadPhone(): string {
  uploadSeq += 1;
  const phone = `+1 555 ${UPLOAD_BLOCK} ${String(uploadSeq).padStart(4, "0")}`;
  uploadedPhones.push(phone);
  return phone;
}

async function upload(user: TestUser, content: string, filename: string): Promise<CallResult> {
  const form = new FormData();
  form.append("file", new File([content], filename, { type: "text/csv" }));
  form.append("source", "google");
  return call("/api/leads/upload", { method: "POST", cookie: user.cookie, body: form });
}

async function s6Import(agent: TestUser): Promise<void> {
  section("6  CSV import via POST /api/leads/upload");

  // Two uploaders: the import limit is 10 per 10 minutes per user.
  const uploader = await createUser("ADMIN", "uploader");
  const uploader2 = await createUser("ADMIN", "uploader2");
  const header = ["name", "address", "phone", "website", "category"];

  // valid
  const valid = await upload(uploader, csv([
    header,
    [`Valid One ${PREFIX}`, "1 Alpha Rd, Springfield", uploadPhone(), "https://one.example", "Dentist"],
    [`Valid Two ${PREFIX}`, "2 Beta Rd, Springfield", uploadPhone(), "", "Dentist"],
  ]), `${PREFIX}-valid.csv`);
  check(
    "valid 2-row CSV -> 200, imported 2",
    valid.status === 200 && valid.json?.imported === 2,
    `status ${valid.status} ${valid.text.slice(0, 200)}`,
  );
  info(`upload response keys: ${valid.json ? Object.keys(valid.json).join(", ") : valid.text.slice(0, 80)}`);

  const empty = await upload(uploader, "", `${PREFIX}-empty.csv`);
  check("empty file -> 400", empty.status === 400, `status ${empty.status} ${empty.text.slice(0, 160)}`);
  info(`empty file -> ${empty.status} ${empty.json?.error ?? ""}: ${empty.json?.message ?? ""}`);

  const headerOnly = await upload(uploader, csv([header]), `${PREFIX}-header.csv`);
  check("header-only file -> 400 no_rows", headerOnly.status === 400 && headerOnly.json?.error === "no_rows", `status ${headerOnly.status} ${headerOnly.text.slice(0, 160)}`);

  const noName = await upload(uploader, csv([["phone", "address"], [uploadPhone(), "x"]]), `${PREFIX}-noname.csv`);
  check("missing name column -> 400 invalid_csv", noName.status === 400 && noName.json?.error === "invalid_csv", `status ${noName.status} ${noName.text.slice(0, 160)}`);
  const noPhone = await upload(uploader, csv([["name", "address"], [`No Phone ${PREFIX}`, "x"]]), `${PREFIX}-nophone.csv`);
  check(
    "missing phone column -> 400 no_rows, row counted as removedNoPhone",
    noPhone.status === 400 && noPhone.json?.error === "no_rows" && noPhone.json?.removedNoPhone === 1,
    `status ${noPhone.status} ${noPhone.text.slice(0, 160)}`,
  );

  // leading zero
  uploadSeq += 1;
  const zeroPhone = `0${UPLOAD_BLOCK}${String(uploadSeq).padStart(7, "0")}`;
  uploadedPhones.push(zeroPhone);
  const zero = await upload(uploader, csv([header, [`Leading Zero ${PREFIX}`, "3 Gamma Rd", zeroPhone, "", ""]]), `${PREFIX}-zero.csv`);
  const zeroRow = await prisma.lead.findFirst({ where: { name: `Leading Zero ${PREFIX}` }, select: { phone: true } });
  check("leading-zero phone is preserved exactly", zero.status === 200 && zeroRow?.phone === zeroPhone, `status ${zero.status} stored ${zeroRow?.phone}`);

  // formula-like cells
  const formulaName = `=HYPERLINK("http://evil.example","${PREFIX}")`;
  const formula = await upload(uploader, csv([header, [formulaName, "4 Delta Rd", uploadPhone(), "", "=1+2"]]), `${PREFIX}-formula.csv`);
  const formulaRow = await prisma.lead.findFirst({ where: { name: formulaName }, select: { name: true, categories: true } });
  check("a formula-like name is imported and stored verbatim", formula.status === 200 && formulaRow?.name === formulaName, `status ${formula.status} ${formula.text.slice(0, 120)}`);
  if (formulaRow) {
    const lead = { ...blankLead(), name: formulaRow.name, categories: formulaRow.categories };
    const exported = toExportRows([lead])[0]!;
    check("…and is neutralised on export (leading apostrophe)", exported.Name === `'${formulaName}` && exported.Category === "'=1+2", `Name=${exported.Name} Category=${exported.Category}`);
  }

  // non-English names
  const intl = [`مطعم لاہور ${PREFIX} ur`, `مطعم القاهرة ${PREFIX} ar`, `北京烤鸭店 ${PREFIX} zh`];
  const intlRes = await upload(uploader, csv([
    header,
    [intl[0]!, "5 Urdu Rd", uploadPhone(), "", ""],
    [intl[1]!, "6 Arabic Rd", uploadPhone(), "", ""],
    [intl[2]!, "7 Chinese Rd", uploadPhone(), "", ""],
  ]), `${PREFIX}-intl.csv`);
  const intlRows = await prisma.lead.findMany({ where: { name: { in: intl } }, select: { name: true } });
  check(
    "Urdu / Arabic / Chinese names: all 3 imported and stored byte-for-byte",
    intlRes.status === 200 && intlRes.json?.imported === 3 && sameSet(intl, intlRows.map((r) => r.name)),
    `status ${intlRes.status} imported ${intlRes.json?.imported} found ${intlRows.length}`,
  );
  // Non-Latin names *without* the ASCII prefix — the de-dup key normalises
  // names to [a-z0-9], which would collapse every non-Latin name to "".
  const pureIntl = ["مطعم الأصيل", "北京饭店"];
  const pureRes = await upload(uploader2, csv([
    header,
    [pureIntl[0]!, `8 ${PREFIX} Rd`, uploadPhone(), "", ""],
    [pureIntl[1]!, `8 ${PREFIX} Rd`, uploadPhone(), "", ""],
  ]), `${PREFIX}-intl2.csv`);
  check(
    "two different pure non-Latin names at the same address, different phones: both imported",
    pureRes.status === 200 && pureRes.json?.imported === 2,
    `status ${pureRes.status} imported ${pureRes.json?.imported} removedDuplicates ${pureRes.json?.removedDuplicates}`,
  );

  // duplicates within the file
  const dupPhone = uploadPhone();
  const dup = await upload(uploader2, csv([
    header,
    [`Dup Clinic ${PREFIX}`, "9 Epsilon Rd", dupPhone, "", ""],
    [`Dup Clinic ${PREFIX}`, "9 Epsilon Rd", dupPhone, "", ""],
  ]), `${PREFIX}-dup.csv`);
  check(
    "an exact duplicate row within a file is collapsed (imported 1, removedDuplicates 1)",
    dup.status === 200 && dup.json?.imported === 1 && dup.json?.removedDuplicates === 1,
    `status ${dup.status} ${dup.text.slice(0, 200)}`,
  );

  // same name, blank address, different phones (audit claim)
  const sameName = `Same Name Clinic ${PREFIX}`;
  const same = await upload(uploader2, csv([
    header,
    [sameName, "", uploadPhone(), "", ""],
    [sameName, "", uploadPhone(), "", ""],
  ]), `${PREFIX}-samename.csv`);
  const sameRows = await prisma.lead.count({ where: { name: sameName } });
  info(`same name + blank address + different phones: status ${same.status}, imported ${same.json?.imported}, removedDuplicates ${same.json?.removedDuplicates}, rows in DB ${sameRows}`);
  check(
    "same name, BLANK address, DIFFERENT phones: both rows imported",
    same.status === 200 && same.json?.imported === 2 && sameRows === 2,
    `imported ${same.json?.imported}, removedDuplicates ${same.json?.removedDuplicates}, rows ${sameRows}`,
  );

  const byAgent = await upload(agent, csv([header, [`Agent Upload ${PREFIX}`, "", uploadPhone(), "", ""]]), `${PREFIX}-agent.csv`);
  check("an AGENT upload -> 403", byAgent.status === 403, `status ${byAgent.status}`);
  check("…and imported nothing", (await prisma.lead.count({ where: { name: `Agent Upload ${PREFIX}` } })) === 0);
}

/* ========================================================================== */
/* 7  Export                                                                  */
/* ========================================================================== */

function blankLead(): Lead {
  return {
    id: "x",
    name: "Export Test",
    address: "",
    categories: [],
    phone: null,
    website: null,
    rating: null,
    owner: null,
    url: null,
    source: "google",
    country: null,
    city: null,
    status: "not_called",
    messageStatus: "not_messaged",
    onWhatsapp: null,
    notes: "",
    callbackDate: null,
    meetingTime: null,
    meetingAttendees: null,
    meetingNotes: "",
    meetingCompletedAt: null,
  } as Lead;
}

async function s7Export(): Promise<void> {
  section("7  Export (lib/exportLeads.ts, built the way exportCsv/exportXlsx build it)");

  const phone = "+92 300 1234567";
  const lead: Lead = { ...blankLead(), phone, notes: "=SUM(A1:A2)", name: "-minus name" };
  const rows = toExportRows([lead]);
  info(`toExportRows Phone cell = ${JSON.stringify(rows[0]!.Phone)}; neutraliseFormula("${phone}") = ${JSON.stringify(neutraliseFormula(phone))}`);

  // CSV, as exportCsv does it.
  const csvText = Papa.unparse(rows, { columns: EXPORT_COLUMN_HEADERS });
  const parsedBack = Papa.parse<string[]>(csvText).data[1]!;
  const csvPhone = parsedBack[EXPORT_COLUMN_HEADERS.indexOf("Phone")];
  info(`CSV Phone cell = ${JSON.stringify(csvPhone)}`);
  check("CSV: a formula in Notes is neutralised", parsedBack[EXPORT_COLUMN_HEADERS.indexOf("Notes")] === "'=SUM(A1:A2)");

  // XLSX, as exportXlsx does it.
  const sheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMN_HEADERS });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Leads");
  const data = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const reread = XLSX.read(new Uint8Array(data), { type: "array" });
  const ws = reread.Sheets.Leads!;
  const phoneCol = XLSX.utils.encode_col(EXPORT_COLUMN_HEADERS.indexOf("Phone"));
  const notesCol = XLSX.utils.encode_col(EXPORT_COLUMN_HEADERS.indexOf("Notes"));
  const phoneCell = ws[`${phoneCol}2`];
  const notesCell = ws[`${notesCol}2`];
  info(`XLSX Phone cell: t=${phoneCell?.t} v=${JSON.stringify(phoneCell?.v)} f=${phoneCell?.f ?? "-"}`);
  check(
    // Deliberate (lib/exportLeads.ts, test-security-offline LP-03): every
    // cell starting with a formula trigger is prefixed, phones included, so a
    // cell edited and re-entered in Excel cannot become a formula.
    `XLSX: the phone cell is a text cell holding "'${phone}" (the LP-03 neutralisation)`,
    phoneCell?.t === "s" && phoneCell?.v === `'${phone}` && !phoneCell?.f,
    `cell value ${JSON.stringify(phoneCell?.v)}`,
  );
  check("XLSX: no cell is written as a formula", Object.keys(ws).filter((k) => !k.startsWith("!")).every((k) => !ws[k].f));
  info(`XLSX Notes cell: v=${JSON.stringify(notesCell?.v)}`);
}

/* ========================================================================== */
/* 8  Metrics                                                                 */
/* ========================================================================== */

async function s8Metrics(admin: TestUser): Promise<void> {
  section("8  Performance metrics vs lib/performance.ts definitions");

  const worker = await createUser("AGENT", "metrics");
  const [a, b, c] = [1700, 1701, 1702].map((i) => synthetic.find((s) => s.index === i)!);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const steps: Array<[Synthetic, unknown]> = [
    [a, { status: "interested" }],
    [a, { status: "interested" }],
    [b, { status: "interested" }],
    [b, { status: "not_interested" }],
    [c, { callbackDate: tomorrow, meetingTime: "10:00" }],
    [c, { meetingTime: "11:00" }],
  ];
  for (const [lead, body] of steps) {
    const res = await call(`/api/leads/${lead.id}`, { method: "PATCH", cookie: worker.cookie, json: body });
    if (res.status !== 200) check(`PATCH ${JSON.stringify(body)} -> 200`, false, `status ${res.status}`);
  }

  const acts = await prisma.leadActivity.findMany({ where: { userId: worker.id }, select: { leadId: true, kind: true, status: true } });
  const calls = acts.filter((x) => x.kind === "call_logged");
  const def = {
    calls: calls.length,
    leadsWorked: new Set(calls.map((x) => x.leadId)).size,
    // Distinct leads that reached interested — the unit leadsWorked is in.
    interested: new Set(calls.filter((x) => x.status === "interested").map((x) => x.leadId)).size,
    meetingsBooked: acts.filter((x) => x.kind === "meeting_booked").length,
  };
  info(`lead_activities for the agent: ${acts.map((x) => `${x.kind}${x.status ? `:${x.status}` : ""}`).join(", ")}`);

  const team = await call("/api/reports/team?range=today", { cookie: admin.cookie });
  const row: PerformanceMetrics | undefined = team.json?.report?.agents?.find((x: { userId: string }) => x.userId === worker.id);
  const me = await call("/api/performance/me", { cookie: worker.cookie });
  const mine: PerformanceMetrics | undefined = me.json?.performance?.today;
  check("GET /api/reports/team?range=today (admin) -> 200 with the agent's row", team.status === 200 && Boolean(row), `status ${team.status}`);
  check("GET /api/performance/me (agent) -> 200", me.status === 200 && Boolean(mine), `status ${me.status}`);
  if (!row || !mine) return;

  const fmt = (m: PerformanceMetrics) =>
    `calls=${m.calls} leadsWorked=${m.leadsWorked} interested=${m.interested} meetingsBooked=${m.meetingsBooked} conversion=${conversionRate(m)?.toFixed(1)}%`;
  info(`team report: ${fmt(row)}`);
  info(`performance/me: ${fmt(mine)}`);

  for (const [label, m] of [["team report", row], ["performance/me", mine]] as const) {
    check(`${label}: calls == count(call_logged) == 4`, m.calls === def.calls && m.calls === 4, `calls ${m.calls}, def ${def.calls}`);
    check(`${label}: leadsWorked == distinct called leads == 2`, m.leadsWorked === def.leadsWorked && m.leadsWorked === 2, `leadsWorked ${m.leadsWorked}`);
    check(`${label}: interested matches its definition (distinct leads saved as interested = ${def.interested})`, m.interested === def.interested, `interested ${m.interested}`);
    const conversion = conversionRate(m);
    check(
      `${label}: conversion (interested / leadsWorked) is at most 100%`,
      conversion !== null && conversion <= 100,
      `conversion ${conversion?.toFixed(1)}% (interested ${m.interested} / leadsWorked ${m.leadsWorked})`,
    );
    check(
      `${label}: one meeting, rescheduled once, counts as 1 meeting booked`,
      m.meetingsBooked === 1,
      `meetingsBooked ${m.meetingsBooked}`,
    );
  }
  check("team report and performance/me agree", fmt(row) === fmt(mine));
}

/* ========================================================================== */
/* 9  Recordings                                                              */
/* ========================================================================== */

function makeWav(bytes: number): Uint8Array {
  const dataLen = Math.max(0, bytes - 44);
  const buffer = Buffer.alloc(44 + dataLen);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLen, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLen, 40);
  return new Uint8Array(buffer);
}

async function uploadRecording(user: TestUser, leadId: string, bytes: Uint8Array, name: string, type: string): Promise<CallResult> {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type }));
  form.append("durationSeconds", "1");
  return call(`/api/meetings/${leadId}/recording`, { method: "POST", cookie: user.cookie, body: form });
}

async function s9Recordings(admin: TestUser): Promise<void> {
  section("9  Meeting recordings");

  const owner = await createUser("AGENT", "recowner");
  const other = await createUser("AGENT", "recother");
  const lead = synthetic.find((s) => s.index === 1)!; // status interested -> on the agenda
  recordingLeadIds.add(lead.id);

  const wav = makeWav(4096);
  const up = await uploadRecording(owner, lead.id, wav, "call.wav", "audio/wav");
  check("a small valid WAV uploads (201, audio/wav)", up.status === 201 && up.json?.recording?.fileType === "audio/wav", `status ${up.status} ${up.text.slice(0, 160)}`);

  const empty = await uploadRecording(owner, synthetic.find((s) => s.index === 2)!.id, new Uint8Array(0), "empty.mp3", "audio/mpeg");
  recordingLeadIds.add(synthetic.find((s) => s.index === 2)!.id);
  check("an empty file is refused (400)", empty.status === 400, `status ${empty.status} ${empty.json?.error ?? ""}`);

  const text = new TextEncoder().encode("This is plainly a text file, not audio. ".repeat(40));
  const fake = await uploadRecording(owner, synthetic.find((s) => s.index === 3)!.id, text, "notes.mp3", "audio/mpeg");
  recordingLeadIds.add(synthetic.find((s) => s.index === 3)!.id);
  check("a .txt renamed .mp3 is refused (415)", fake.status === 415, `status ${fake.status} ${fake.json?.error ?? ""}`);

  const oversized = makeWav(25 * 1024 * 1024 + 1024 * 1024); // 26 MB, limit is 25 MB
  const big = await uploadRecording(owner, synthetic.find((s) => s.index === 4)!.id, oversized, "big.wav", "audio/wav");
  recordingLeadIds.add(synthetic.find((s) => s.index === 4)!.id);
  check("a 26 MB recording is refused with 413 (limit 25 MB)", big.status === 413, `status ${big.status} ${big.json?.error ?? big.text.slice(0, 80)}`);

  const notMeeting = synthetic.find((s) => s.index === 1500)!;
  recordingLeadIds.add(notMeeting.id);
  const nm = await uploadRecording(owner, notMeeting.id, wav, "call.wav", "audio/wav");
  check("a lead not on the meetings agenda cannot hold a recording (400)", nm.status === 400, `status ${nm.status} ${nm.json?.error ?? ""}`);

  const ownStream = await fetch(`${BASE_URL}/api/meetings/${lead.id}/recording/stream`, { headers: { cookie: owner.cookie } });
  const ownBytes = new Uint8Array(await ownStream.arrayBuffer());
  check("the uploader can stream it back byte-for-byte", ownStream.status === 200 && Buffer.compare(Buffer.from(ownBytes), Buffer.from(wav)) === 0, `status ${ownStream.status} len ${ownBytes.length}`);

  const otherStream = await call(`/api/meetings/${lead.id}/recording/stream`, { cookie: other.cookie });
  check("another agent cannot stream it (404/403)", otherStream.status === 404 || otherStream.status === 403, `status ${otherStream.status}`);
  const otherRange = await call(`/api/meetings/${lead.id}/recording/stream`, { cookie: other.cookie, headers: { range: "bytes=0-99" } });
  check("…nor fetch a byte range of it", otherRange.status === 404 || otherRange.status === 403, `status ${otherRange.status}`);
  const otherMeta = await call(`/api/meetings/${lead.id}/recording`, { cookie: other.cookie });
  check("…nor read its metadata", otherMeta.status === 404 || otherMeta.status === 403, `status ${otherMeta.status}`);
  const otherDetail = await call(`/api/leads/${lead.id}`, { cookie: other.cookie });
  check("…and GET /api/leads/:id gives them recording: null", otherDetail.status === 200 && otherDetail.json?.recording === null, `recording ${JSON.stringify(otherDetail.json?.recording)?.slice(0, 60)}`);
  const otherList = await call("/api/recordings", { cookie: other.cookie });
  check("…and GET /api/recordings does not list it for them", otherList.status === 200 && !otherList.text.includes(lead.id), `status ${otherList.status}`);
  const otherReplace = await uploadRecording(other, lead.id, makeWav(2048), "mine.wav", "audio/wav");
  check("…nor replace it (403)", otherReplace.status === 403, `status ${otherReplace.status}`);
  const otherDelete = await call(`/api/meetings/${lead.id}/recording`, { method: "DELETE", cookie: other.cookie });
  check("…nor delete it (404/403)", otherDelete.status === 404 || otherDelete.status === 403, `status ${otherDelete.status}`);
  const anonStream = await call(`/api/meetings/${lead.id}/recording/stream`);
  check("anonymous stream -> 401", anonStream.status === 401, `status ${anonStream.status}`);

  const adminStream = await call(`/api/meetings/${lead.id}/recording/stream`, { cookie: admin.cookie });
  check("an administrator can stream it", adminStream.status === 200, `status ${adminStream.status}`);

  const del = await call(`/api/meetings/${lead.id}/recording`, { method: "DELETE", cookie: owner.cookie });
  check("the uploader can delete it", del.status === 200, `status ${del.status}`);
}

/* ========================================================================== */
/* Cleanup                                                                    */
/* ========================================================================== */

async function cleanup(): Promise<void> {
  section("Cleanup");
  try {
    const { deleteRecording } = await import("../lib/recordingStorage");
    const leadFilter = {
      OR: [
        { name: { contains: PREFIX } },
        { address: { contains: PREFIX } },
        ...(uploadedPhones.length ? [{ phone: { in: uploadedPhones } }] : []),
        ...(createdUserIds.size ? [{ createdById: { in: [...createdUserIds] } }] : []),
      ],
    };
    const leadIds = (await prisma.lead.findMany({ where: leadFilter, select: { id: true } })).map((l) => l.id);
    const recordings = await prisma.meetingRecording.findMany({
      where: { OR: [{ leadId: { in: [...leadIds, ...recordingLeadIds] } }, { uploadedById: { in: [...createdUserIds] } }] },
      select: { id: true, storageKey: true },
    });
    for (const r of recordings) await deleteRecording(r.storageKey).catch(() => {});
    await prisma.meetingRecording.deleteMany({ where: { id: { in: recordings.map((r) => r.id) } } });
    // lead_activities and lead_changes cascade with the lead.
    for (let i = 0; i < leadIds.length; i += 1000) {
      await prisma.lead.deleteMany({ where: { id: { in: leadIds.slice(i, i + 1000) } } });
    }
    const users = (await prisma.user.findMany({ where: { username: { startsWith: PREFIX } }, select: { id: true } })).map((u) => u.id);
    const allUsers = [...new Set([...users, ...createdUserIds])];
    await prisma.leadActivity.deleteMany({ where: { userId: { in: allUsers } } });
    await prisma.leadChange.deleteMany({ where: { userId: { in: allUsers } } });
    await prisma.timeAdjustment.deleteMany({ where: { OR: [{ adminId: { in: allUsers } }, { userId: { in: allUsers } }] } });
    await prisma.passwordReset.deleteMany({ where: { OR: [{ issuedById: { in: allUsers } }, { userId: { in: allUsers } }] } });
    for (const id of allUsers) {
      await prisma.rateLimit.deleteMany({ where: { key: { endsWith: `:${id}` } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });

    const leftUsers = await prisma.user.count({ where: { username: { contains: "qae2e" } } });
    const leftLeads = await prisma.lead.count({
      where: { OR: [{ name: { contains: "qae2e" } }, { address: { contains: "qae2e" } }, ...(uploadedPhones.length ? [{ phone: { in: uploadedPhones } }] : [])] },
    });
    const leftRates = await prisma.rateLimit.count({ where: { key: { in: allUsers.flatMap((id) => [`lead-search:${id}`, `lead-import:${id}`]) } } });
    check(
      "cleanup left zero qae2e users, leads and rate-limit rows in lead_portal_qa",
      leftUsers === 0 && leftLeads === 0 && leftRates === 0,
      `users ${leftUsers}, leads ${leftLeads}, rate rows ${leftRates}`,
    );
  } catch (error) {
    check("cleanup completed", false, String(error));
  }
}

/* ========================================================================== */

async function main(): Promise<void> {
  console.log(`QA e2e against ${BASE_URL}, database lead_portal_qa, prefix ${PREFIX}`);
  const started = perf.now();
  try {
    const health = await call("/api/health");
    if (!check("server is up (/api/health 200)", health.status === 200, `status ${health.status}`)) return;

    const admin = await createUser("ADMIN", "admin");
    const agent = await createUser("AGENT", "agent");
    const contributor = await createUser("CONTRIBUTOR", "contrib");

    const run = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        check(`${name} ran to completion`, false, error instanceof Error ? `${error.message}` : String(error));
      }
    };

    await run("section 0", () => s0Login());
    await run("section 1", () => s1Rbac(admin, agent, contributor));
    await run("section 2", () => s2Pagination(contributor));
    if (synthetic.length === SYNTHETIC_COUNT) {
      await run("section 3", () => s3Filters(agent));
      await run("section 4", () => s4Edits(agent));
    }
    await run("section 5", () => s5Injection(admin));
    await run("section 6", () => s6Import(agent));
    await run("section 7", () => s7Export());
    if (synthetic.length === SYNTHETIC_COUNT) {
      await run("section 8", () => s8Metrics(admin));
      await run("section 9", () => s9Recordings(admin));
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  section("Timings (real measurements, ms per GET /api/leads)");
  for (const [label, t] of Object.entries(timings)) {
    console.log(`  ${label}: n=${t.n} median=${t.median.toFixed(1)} max=${t.max.toFixed(1)}`);
  }
  console.log(`  whole run: ${((perf.now() - started) / 1000).toFixed(1)} s`);

  if (failures.length) {
    section("Failures");
    for (const line of failures) console.log(line);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
