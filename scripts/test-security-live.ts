import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { completeSignIn } from "../lib/completeSignIn";
import { PrismaClient } from "../lib/generated/prisma/client";
import { clientIp } from "../lib/loginThrottle";
import { hashPassword } from "../lib/password";

/**
 * The half of the security audit's regression tests that only a running system
 * can answer: a throttle that stays shut across real requests (LP-01), the
 * address actually written to `sessions.ip_address` (LP-01), a cross-site
 * request actually refused and a same-origin one actually served (LP-04), the
 * security headers actually arriving on a page *and* on `/_next/static/*`
 * (LP-05/LP-06), and the authenticated rate limits actually engaging (LP-08).
 *
 *   npm run dev                  (in one terminal)
 *   npm run test:security-live   (in another)
 *
 * `test-security-offline.ts` covers the same rules as functions, in isolation
 * and without a server. Run both.
 *
 * Written the way the other scripts in this directory are, and for the reason
 * `test-productivity.ts` sets out: the claims worth checking here are claims
 * about HTTP, a session cookie and a row in Postgres, and a mocked version of
 * any of the three would pass whether or not the real thing works.
 *
 * ---------------------------------------------------------------------------
 * What it does to the system it runs against
 * ---------------------------------------------------------------------------
 * It creates two throwaway accounts (`sectest-*`), signs them in by inserting
 * session rows the way `lib/session.ts` does, and deletes all of it on the way
 * out including after a failure. It touches no existing user, lead, session or
 * screenshot.
 *
 * Three deliberate side effects, all local and all temporary:
 *
 *   * the login throttle's in-process IP window for this dev server is filled
 *     and stays shut for fifteen minutes, or until the server restarts. That
 *     is the thing being tested. Sign-ins from this machine will answer 429
 *     until then — restart `npm run dev` if that is in the way.
 *   * `rate_limits` rows are written for the throwaway accounts, and deleted
 *     again at the end.
 *   * `POST /api/leads/upload` is called with a header-only CSV, which is
 *     refused as "no usable rows" and imports nothing.
 *
 * It performs no load testing. Every loop below runs exactly as far as the
 * documented limit, which is what proves the limit exists.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "security-live-test-Pa55phrase";

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

/** The address an attacker would put in the headers they control. */
const SPOOFED_IP = "203.0.113.253";

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

function skip(name: string, why: string): void {
  console.log(`  SKIP  ${name} — ${why}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const createdUsers: string[] = [];
const rateLimitKeys: string[] = [];

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function createUser(
  role: "ADMIN" | "AGENT",
  suffix: string,
): Promise<{ id: string; username: string }> {
  const username = `sectest-${suffix}-${randomBytes(3).toString("hex")}`;
  const user = await prisma.user.create({
    data: {
      name: `Security Test ${suffix}`,
      email: `${username}@example.invalid`,
      username,
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    },
    select: { id: true, username: true },
  });
  createdUsers.push(user.id);
  return user;
}

/** Mint a portal session for a user and return the cookie header value. */
async function signIn(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + 12 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      userAgent: "security-live-test",
      ipAddress: "127.0.0.1",
    },
  });
  return `${SESSION_COOKIE}=${token}`;
}

const origin = new URL(BASE_URL).origin;

/** Headers a browser on this origin would send with a state-changing request. */
function sameOriginHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

/** Headers a browser on somebody else's page would send. */
function crossSiteHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
    "content-type": "application/json",
  };
}

async function call(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init });
}

/* -------------------------------------------------------------------------- */
/* LP-01 — the throttle and the recorded address                              */
/* -------------------------------------------------------------------------- */

/**
 * The order here matters. The recorded-address check signs in for real, and the
 * exhaustion check that follows fills the IP window that sign-in needs — so it
 * has to come first.
 */
async function lp01(): Promise<void> {
  section("LP-01  sessions.ip_address is not attacker-controlled");

  const admin = await createUser("ADMIN", "ip");

  /*
   * This used to sign the administrator in with one request, because that role
   * finished on the password alone. It does not any more — the bypass was
   * removed and every role now redeems an emailed code — so the check is in two
   * halves, and the first half is a stronger property than the one it replaces.
   *
   * A test cannot read the mailbox and the code is stored as a scrypt hash, so
   * the session-minting half is exercised against `completeSignIn` directly,
   * fed by the same `clientIp` the verify route feeds it. That is the whole of
   * what LP-01 was ever about: the address written to `sessions.ip_address` is
   * derived by the server from a trusted hop count, never copied from a header.
   */
  const login = await call("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Everything an attacker can write, all at once.
      "x-forwarded-for": `${SPOOFED_IP}, 10.9.9.9`,
      "x-real-ip": SPOOFED_IP,
    },
    body: JSON.stringify({ username: admin.username, password: PASSWORD }),
  });

  if (login.status !== 200) {
    skip(
      "a correct administrator password mints no session",
      `login answered ${login.status} (an earlier run may still have the IP window shut)`,
    );
  } else {
    const body = (await login.json().catch(() => null)) as { otpRequired?: unknown } | null;
    check(
      "a correct administrator password mints no session",
      (await prisma.session.count({ where: { userId: admin.id } })) === 0,
      `otpRequired=${String(body?.otpRequired)}`,
    );
    check(
      "…it demands the emailed code, like every other role",
      body?.otpRequired === true,
      `otpRequired=${String(body?.otpRequired)}`,
    );
  }

  // The address the server would record, derived from the same spoofed headers
  // by the same function the verify route uses.
  const spoofed = new Request(`${BASE_URL}/api/auth/otp/verify`, {
    method: "POST",
    headers: {
      "x-forwarded-for": `${SPOOFED_IP}, 10.9.9.9`,
      "x-real-ip": SPOOFED_IP,
    },
  });
  await completeSignIn(admin.id, {
    userAgent: "security-live-test",
    ipAddress: clientIp(spoofed),
  });

  const session = await prisma.session.findFirst({
    where: { userId: admin.id },
    orderBy: { createdAt: "desc" },
    select: { ipAddress: true },
  });
  check(
    "the spoofed address is not recorded on the session",
    session !== null && session.ipAddress !== SPOOFED_IP,
    `ip_address=${session?.ipAddress ?? "no session row"}`,
  );
  // In development `TRUSTED_PROXY_HOPS` defaults to 0, so the honest answer is
  // "no proxy said, therefore unknown" rather than anything the caller wrote.
  check(
    "…it is the shared bucket, since this server has no proxy in front of it",
    session?.ipAddress === "unknown",
    `ip_address=${session?.ipAddress}`,
  );

  section("LP-01  a spoofed X-Forwarded-For does not reset the IP throttle");

  // MAX_PER_IP is 30. A different username each time, so it is unmistakably the
  // *address* window that closes — and a different spoofed header each time,
  // which under the old leftmost-hop reading would have been a fresh bucket per
  // request and therefore no throttle at all.
  let sawLock = false;
  let lockedAt = 0;
  for (let attempt = 0; attempt < 34 && !sawLock; attempt += 1) {
    const response = await call("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${attempt % 200}`,
        "x-real-ip": `198.51.100.${attempt % 200}`,
      },
      body: JSON.stringify({
        username: `sectest-nobody-${attempt}-${randomBytes(2).toString("hex")}`,
        password: "wrong-password-on-purpose",
      }),
    });
    if (response.status === 429) {
      sawLock = true;
      lockedAt = attempt + 1;
      check(
        "the IP window closes despite a fresh spoofed address every request",
        true,
        `after ${lockedAt} attempts`,
      );
      check(
        "the refusal carries Retry-After",
        Number(response.headers.get("retry-after") ?? 0) > 0,
        response.headers.get("retry-after") ?? "absent",
      );
    }
  }

  if (!sawLock) {
    check(
      "the IP window closes despite a fresh spoofed address every request",
      false,
      "34 failed sign-ins with rotating headers were all accepted",
    );
  }

  // And once shut, a *new* spoofed value does not open it again.
  const afterLock = await call("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "192.0.2.77",
      "x-real-ip": "192.0.2.77",
    },
    body: JSON.stringify({ username: "sectest-nobody-final", password: "wrong" }),
  });
  check(
    "a brand-new spoofed address does not open the window again",
    afterLock.status === 429,
    `status ${afterLock.status}`,
  );
}

/* -------------------------------------------------------------------------- */
/* LP-04 — cross-site state changes                                           */
/* -------------------------------------------------------------------------- */

async function lp04(): Promise<void> {
  section("LP-04  cross-site state-changing requests");

  const admin = await createUser("ADMIN", "csrf");
  const cookie = await signIn(admin.id);

  // A deliberately invalid body, so a request that gets *through* the check
  // answers 400 and creates nothing. The status is the whole assertion: 403 is
  // the CSRF refusal, 400 means it reached the handler.
  const body = JSON.stringify({ nothing: "useful" });

  const crossSite = await call("/api/users", {
    method: "POST",
    headers: crossSiteHeaders(cookie),
    body,
  });
  check(
    "a cross-site POST with a valid session cookie is refused",
    crossSite.status === 403,
    `status ${crossSite.status}`,
  );
  const crossSiteBody = (await crossSite.json().catch(() => ({}))) as { error?: string };
  check(
    "…as a cross-site request, not as a role failure",
    crossSiteBody.error === "cross_site_request",
    JSON.stringify(crossSiteBody),
  );

  const sameOrigin = await call("/api/users", {
    method: "POST",
    headers: sameOriginHeaders(cookie),
    body,
  });
  check(
    "the same request from this origin reaches the handler",
    sameOrigin.status === 400,
    `status ${sameOrigin.status}`,
  );

  const forgedOrigin = await call("/api/users", {
    method: "POST",
    headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
    body,
  });
  check(
    "an Origin from elsewhere is refused even with no Sec-Fetch-Site",
    forgedOrigin.status === 403,
    `status ${forgedOrigin.status}`,
  );

  const readCrossSite = await call("/api/leads?rows=0", {
    headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  });
  check(
    "a cross-site GET is not affected",
    readCrossSite.status === 200,
    `status ${readCrossSite.status}`,
  );

  const noBrowserHeaders = await call("/api/users", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body,
  });
  check(
    "a non-browser caller with a session still works",
    noBrowserHeaders.status === 400,
    `status ${noBrowserHeaders.status}`,
  );

  // The monitor endpoints must be untouched by any of this: they are bearer
  // authenticated and send no Origin at all.
  const monitor = await call("/api/monitor/session", {
    headers: { authorization: "Bearer not-a-real-token" },
  });
  check(
    "a bearer monitor endpoint still answers on its own terms (401, not 403)",
    monitor.status === 401,
    `status ${monitor.status}`,
  );
}

/* -------------------------------------------------------------------------- */
/* LP-05 / LP-06 — security headers                                           */
/* -------------------------------------------------------------------------- */

const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
];

async function lp0506(): Promise<void> {
  section("LP-05/06  security headers on a page");

  const page = await call("/login");
  for (const header of REQUIRED_HEADERS) {
    check(`/login sends ${header}`, page.headers.get(header) !== null);
  }
  check(
    "the CSP still forbids framing and foreign form posts",
    (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") &&
      (page.headers.get("content-security-policy") ?? "").includes("form-action 'self'"),
    page.headers.get("content-security-policy") ?? "absent",
  );
  check(
    "HSTS is left to the TLS terminator",
    page.headers.get("strict-transport-security") === null,
    page.headers.get("strict-transport-security") ?? "",
  );

  section("LP-05/06  security headers on /_next/static/*");

  const html = await page.text();
  const asset = /\/_next\/static\/[^"']+?\.(?:js|css)/.exec(html)?.[0];
  if (!asset) {
    skip("a /_next/static asset carries the same headers", "no asset URL in the login HTML");
    return;
  }

  const staticResponse = await call(asset);
  check(`the asset is served (${asset.slice(0, 48)}…)`, staticResponse.status === 200);
  for (const header of REQUIRED_HEADERS) {
    check(`/_next/static sends ${header}`, staticResponse.headers.get(header) !== null);
  }
}

/* -------------------------------------------------------------------------- */
/* LP-08 — authenticated rate limits                                          */
/* -------------------------------------------------------------------------- */

async function lp08(): Promise<void> {
  section("LP-08  lead search");

  const admin = await createUser("ADMIN", "rate");
  const cookie = await signIn(admin.id);
  rateLimitKeys.push(
    `lead-search:${admin.id}`,
    `lead-import:${admin.id}`,
    `screenshot-bulk-delete:${admin.id}`,
    `lead-export:${admin.id}`,
  );

  // The limit is 120 a minute. 125 requests, stopping the moment it engages.
  let searchLocked = 0;
  for (let attempt = 1; attempt <= 125 && searchLocked === 0; attempt += 1) {
    const response = await call(`/api/leads?q=probe&today=2026-08-17`, { headers: { cookie } });
    if (response.status === 429) {
      searchLocked = attempt;
      check(
        "the search limit engages",
        true,
        `at request ${attempt}, Retry-After ${response.headers.get("retry-after")}`,
      );
    }
  }
  if (searchLocked === 0) check("the search limit engages", false, "125 searches all served");
  check(
    "…and not before the limit",
    searchLocked === 0 || searchLocked > 120,
    `engaged at ${searchLocked}`,
  );

  const counts = await call(`/api/leads?rows=0&today=2026-08-17`, { headers: { cookie } });
  check(
    "a counts-only read is not caught by the search limit",
    counts.status === 200,
    `status ${counts.status}`,
  );

  const noQuery = await call(`/api/leads?today=2026-08-17`, { headers: { cookie } });
  check(
    "a plain page read with no search term is not caught either",
    noQuery.status === 200,
    `status ${noQuery.status}`,
  );

  section("LP-08  bulk screenshot deletion");

  // A syntactically valid id that does not exist: the handler reports it as a
  // failure and deletes nothing, so this loop destroys no evidence.
  const fakeIds = JSON.stringify({ ids: ["clzzzzzzzzzzzzzzzzzzzzzzz"] });
  let deleteLocked = 0;
  for (let attempt = 1; attempt <= 24 && deleteLocked === 0; attempt += 1) {
    const response = await call("/api/admin/screenshots", {
      method: "DELETE",
      headers: sameOriginHeaders(cookie),
      body: fakeIds,
    });
    if (response.status === 429) deleteLocked = attempt;
  }
  check("the bulk-delete limit engages", deleteLocked > 0, `engaged at ${deleteLocked}`);
  check(
    "…and not before the limit",
    deleteLocked === 0 || deleteLocked > 20,
    `engaged at ${deleteLocked}`,
  );

  section("LP-08  CSV import");

  // Headers only: parsed, found to contain no usable rows, refused with a 400.
  // Nothing is imported by any of these.
  const emptyCsv = "name,phone,address\n";
  let importLocked = 0;
  for (let attempt = 1; attempt <= 13 && importLocked === 0; attempt += 1) {
    const response = await call("/api/leads/upload", {
      method: "POST",
      headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "text/csv" },
      body: emptyCsv,
    });
    if (response.status === 429) importLocked = attempt;
  }
  check("the import limit engages", importLocked > 0, `engaged at ${importLocked}`);
  check(
    "…and not before the limit",
    importLocked === 0 || importLocked > 10,
    `engaged at ${importLocked}`,
  );

  const leadCount = await prisma.lead.count({ where: { sourceBatch: { contains: "upload-" } } });
  check("no leads were imported by the refused uploads", leadCount === 0, `${leadCount} rows`);

  section("LP-08  the limiter's state is shared, not per-worker");

  const rows = await prisma.rateLimit.findMany({
    where: { key: { in: [`lead-search:${admin.id}`, `lead-import:${admin.id}`] } },
    select: { key: true, count: true },
  });
  check(
    "the counters live in Postgres where every worker can see them",
    rows.length === 2 && rows.every((row) => row.count > 0),
    JSON.stringify(rows),
  );
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("Security regression tests (live)\n================================");
  console.log(`Against ${BASE_URL}\n`);

  const health = await call("/api/health").catch(() => null);
  if (!health || !health.ok) {
    console.error(`Cannot reach ${BASE_URL}. Start the server with \`npm run dev\` first.`);
    process.exitCode = 1;
    return;
  }

  // LP-04, LP-05/06 and LP-08 first: LP-01 deliberately fills the login
  // throttle's IP window, and nothing after it should have to work around that.
  await lp04();
  await lp0506();
  await lp08();
  await lp01();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Ordered so foreign keys are satisfied without relying on cascade rules being
 * what they are today. Runs after a failure as well as after a pass.
 */
async function cleanup(): Promise<void> {
  if (rateLimitKeys.length > 0) {
    await prisma.rateLimit.deleteMany({ where: { key: { in: rateLimitKeys } } }).catch(() => {});
  }
  if (createdUsers.length > 0) {
    await prisma.session.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => {});
    await prisma.workSession.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => {});
    await prisma.loginOtp.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => {});
  }
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
