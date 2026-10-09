import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";

/**
 * Regression tests for five account and shift defects found in the QA audit,
 * against a running server and a real database:
 *
 *   QA-01  a browser whose session was ended elsewhere (sign out everywhere,
 *          reset, role change) loops between `/` and `/login` instead of
 *          landing on the sign-in form;
 *   QA-02  parallel guesses at a sign-in code each get a full comparison, so
 *          the five-attempt cap does not bound the number of guesses;
 *   QA-03  a SpiderHunts Monitor credential survives the account's password
 *          being changed or reset;
 *   QA-04  tabs heartbeating at the same moment each open a shift, and every
 *          report sums the duplicates;
 *   QA-05  a parallel burst of wrong passwords is checked in full, because the
 *          throttle counted failures only after the slow password comparison.
 *
 *   npm run start / npm run dev     (in one terminal)
 *   npm run test:auth-hardening     (in another)
 *
 * QA-02 drives the real sign-in, so the server must be able to "send" mail.
 * Point SMTP_HOST/SMTP_PORT at a local capture sink and set QA_MAIL_LOG to the
 * file it appends raw messages to; without it the QA-02 checks are skipped,
 * not passed.
 *
 * It creates throwaway `authhard-*` accounts and deletes them (and everything
 * that cascades from them) on the way out, including after a failure. Every
 * request carries its own made-up `X-Real-IP`, so the per-IP sign-in throttle
 * it touches is never this machine's — which only has an effect when the
 * server believes forwarding headers (production, `TRUSTED_PROXY_HOPS` ≥ 1).
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ORIGIN = new URL(BASE_URL).origin;
const PASSWORD = "auth-hardening-Pa55phrase";
const PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_COOKIE = PRODUCTION ? "__Host-lp_session" : "lp_session";
const OTP_COOKIE = PRODUCTION ? "__Host-lp_otp" : "lp_otp";
const MAIL_LOG = process.env.QA_MAIL_LOG ?? join(tmpdir(), "qa", "mail.log");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let passed = 0;
let failed = 0;
let skipped = 0;

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
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const createdUsers: string[] = [];
let ipCounter = 0;

/** A fresh documentation-range address per call, so no throttle window is shared. */
function fakeIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function makeUser(role: "ADMIN" | "AGENT", label: string) {
  const username = `authhard-${label}-${stamp}`;
  const user = await prisma.user.create({
    data: {
      name: `Auth Hardening ${label}`,
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

async function sessionCookie(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + 12 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      userAgent: "auth-hardening-test",
      ipAddress: "127.0.0.1",
    },
  });
  return `${SESSION_COOKIE}=${token}`;
}

function cookieFrom(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [key, value] = pair.split("=");
    if (key.trim() === name && value) return `${name}=${value}`;
  }
  return null;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "X-Real-IP": fakeIp(),
      ...headers,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/* -------------------------------------------------------------------------- */
/* Mail sink                                                                  */
/* -------------------------------------------------------------------------- */

/** The six-digit codes in the captured messages addressed to `email`, oldest first. */
function codesFor(email: string): string[] {
  if (!existsSync(MAIL_LOG)) return [];
  const messages = readFileSync(MAIL_LOG, "utf8").split("=====END=====");
  const codes: string[] = [];
  for (const raw of messages) {
    if (!raw.toLowerCase().includes(email.toLowerCase())) continue;
    // Bodies may be quoted-printable or base64; decode every base64 run and
    // search the result together with the raw text.
    const unfolded = raw.replace(/=\r?\n/g, "");
    const decoded = (unfolded.match(/^[A-Za-z0-9+/=]{40,}$/gm) ?? [])
      .map((line) => Buffer.from(line, "base64").toString("utf8"))
      .join("\n");
    const match = `${unfolded}\n${decoded}`.match(/\b(\d{6})\b/);
    if (match) codes.push(match[1]);
  }
  return codes;
}

async function waitForCode(email: string, after: number): Promise<string | null> {
  for (let i = 0; i < 50; i += 1) {
    const codes = codesFor(email);
    if (codes.length > after) return codes[codes.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Password step of a real sign-in; returns the pending-challenge cookie. */
async function startSignIn(username: string, email: string): Promise<{ otp: string; code: string } | null> {
  const before = codesFor(email).length;
  const response = await post("/api/auth/login", { username, password: PASSWORD });
  const otp = cookieFrom(response, OTP_COOKIE);
  if (!response.ok || !otp) return null;
  const code = await waitForCode(email, before);
  return code ? { otp, code } : null;
}

function wrongCode(right: string, seed: number): string {
  let candidate = String((Number(right) + 1 + seed * 7919) % 1_000_000).padStart(6, "0");
  if (candidate === right) candidate = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
  return candidate;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

async function revokedSessionLandsOnLogin(): Promise<void> {
  section("QA-01  A session ended elsewhere lands on the sign-in form, not a loop");

  const agent = await makeUser("AGENT", "revoked");
  const cookie = await sessionCookie(agent.id);

  const live = await fetch(`${BASE_URL}/`, { headers: { Cookie: cookie }, redirect: "manual" });
  check("the live session loads the portal", live.status === 200, `got ${live.status}`);

  // What sign-out-everywhere, a reset or a role change does to *this* browser.
  await prisma.session.deleteMany({ where: { userId: agent.id } });

  let url = `${BASE_URL}/`;
  let jar = cookie;
  const hops: string[] = [];
  let finalStatus = 0;
  for (let i = 0; i < 8; i += 1) {
    const response = await fetch(url, { headers: { Cookie: jar }, redirect: "manual" });
    finalStatus = response.status;
    // A browser applies a deleting Set-Cookie before following the redirect.
    for (const header of response.headers.getSetCookie()) {
      if (header.startsWith(`${SESSION_COOKIE}=;`) || /Max-Age=0|expires=Thu, 01 Jan 1970/i.test(header)) {
        if (header.startsWith(`${SESSION_COOKIE}=`)) jar = "";
      }
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;
    url = new URL(location, url).toString();
    hops.push(new URL(url).pathname);
  }

  check(
    "it reaches /login and is served the form within a few redirects",
    finalStatus === 200 && hops.length <= 3 && hops[hops.length - 1] === "/login",
    `status ${finalStatus} after ${hops.length} hops: ${hops.join(" → ")}`,
  );
}

async function otpGuessesAreBounded(): Promise<void> {
  section("QA-02  Parallel guesses at a sign-in code are bounded by the attempt cap");

  const agent = await makeUser("AGENT", "otp");
  const email = `${agent.username}@example.invalid`;

  const probe = await startSignIn(agent.username, email);
  if (!probe) {
    skip("parallel guesses are bounded", `no code captured (is SMTP pointed at the sink writing ${MAIL_LOG}?)`);
    return;
  }

  const burst = 20;
  const responses = await Promise.all(
    Array.from({ length: burst }, (_, i) =>
      post("/api/auth/otp/verify", { code: wrongCode(probe.code, i) }, { Cookie: probe.otp }).then(
        async (response) => ({ status: response.status, body: (await response.json()) as { error?: string } }),
      ),
    ),
  );
  const compared = responses.filter((r) => r.body.error === "invalid_code").length;

  const row = await prisma.loginOtp.findFirst({
    where: { userId: agent.id },
    orderBy: { createdAt: "desc" },
    select: { attempts: true },
  });

  check(
    `at most 4 of ${burst} parallel wrong guesses are answered "wrong code" (the 5th locks it)`,
    compared <= 4,
    `${compared} answered invalid_code`,
  );
  check(
    "the stored attempt count never exceeds the cap",
    (row?.attempts ?? 99) <= 5,
    `attempts = ${row?.attempts}`,
  );

  const after = await post("/api/auth/otp/verify", { code: probe.code }, { Cookie: probe.otp });
  check("the right code no longer works once the cap is reached", after.status !== 200, `got ${after.status}`);

  // A correct code racing a burst of wrong ones must not get in once the
  // others have used the attempts up.
  const second = await startSignIn(agent.username, email);
  if (!second) {
    skip("a correct code racing a burst", "no second code captured");
    return;
  }
  const mixed = await Promise.all([
    ...Array.from({ length: 12 }, (_, i) =>
      post("/api/auth/otp/verify", { code: wrongCode(second.code, i) }, { Cookie: second.otp }),
    ),
    post("/api/auth/otp/verify", { code: second.code }, { Cookie: second.otp }),
  ]);
  const mixedRow = await prisma.loginOtp.findFirst({
    where: { userId: agent.id },
    orderBy: { createdAt: "desc" },
    select: { attempts: true },
  });
  const signedIn = mixed[mixed.length - 1].status === 200;
  check(
    "racing a burst, the attempt count still stays within the cap",
    (mixedRow?.attempts ?? 99) <= 5,
    `attempts = ${mixedRow?.attempts}, right code ${signedIn ? "accepted" : "refused"}`,
  );

  // And the ordinary path still works.
  const third = await startSignIn(agent.username, email);
  if (!third) {
    skip("a single right code signs in", "no third code captured");
    return;
  }
  const ok = await post("/api/auth/otp/verify", { code: third.code }, { Cookie: third.otp });
  check("a single right code still signs in", ok.status === 200 && cookieFrom(ok, SESSION_COOKIE) !== null, `got ${ok.status}`);
  const reused = await post("/api/auth/otp/verify", { code: third.code }, { Cookie: third.otp });
  check("and cannot be used twice", reused.status !== 200, `got ${reused.status}`);
}

async function monitorDiesWithPassword(): Promise<void> {
  section("QA-03  A Monitor credential does not survive a password change or reset");

  const { issueDeviceTokens } = await import("../lib/monitorAuth");

  async function deviceWorks(accessToken: string): Promise<number> {
    const response = await fetch(`${BASE_URL}/api/monitor/session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.status;
  }

  // Self-service change, current password proved.
  const agent = await makeUser("AGENT", "monpw");
  const issued = await issueDeviceTokens(agent.id, { deviceName: "auth-hardening" });
  if (!issued.ok) {
    check("a device can be issued for the fixture", false, issued.code);
    return;
  }
  check("the device works before the change", (await deviceWorks(issued.tokens.accessToken)) === 200);

  const cookie = await sessionCookie(agent.id);
  const newPassword = `${PASSWORD}-changed`;
  const change = await post(
    "/api/account/password",
    { currentPassword: PASSWORD, newPassword, confirmPassword: newPassword },
    { Cookie: cookie },
  );
  check("the password change succeeds", change.ok, `got ${change.status}`);
  check(
    "the device's access token is refused after the change",
    (await deviceWorks(issued.tokens.accessToken)) === 401,
  );
  const refresh = await post("/api/monitor/auth/refresh", { refreshToken: issued.tokens.refreshToken });
  check("its refresh token is refused too", refresh.status === 401, `got ${refresh.status}`);

  // Administrator-issued reset code.
  const admin = await makeUser("ADMIN", "monadmin");
  const victim = await makeUser("AGENT", "monreset");
  const second = await issueDeviceTokens(victim.id, { deviceName: "auth-hardening" });
  if (!second.ok) return;
  const adminCookie = await sessionCookie(admin.id);
  const reset = await post(`/api/users/${victim.id}/password-reset`, {}, { Cookie: adminCookie });
  check("an administrator can issue a reset code", reset.ok, `got ${reset.status}`);
  check(
    "issuing the reset disconnects the account's workstations",
    (await deviceWorks(second.tokens.accessToken)) === 401,
  );

  // No administrator sets an existing account's password — not another
  // person's, and not their own. Reset codes are the only route.
  for (const [label, targetId] of [
    ["another user's", victim.id],
    ["their own", admin.id],
  ] as const) {
    const before = await prisma.user.findUnique({ where: { id: targetId }, select: { passwordHash: true } });
    const set = await fetch(`${BASE_URL}/api/users/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
      body: JSON.stringify({ password: `${PASSWORD}-admin-set` }),
    });
    const body = (await set.json().catch(() => ({}))) as { error?: string };
    const after = await prisma.user.findUnique({ where: { id: targetId }, select: { passwordHash: true } });
    check(
      `an administrator cannot set ${label} password through the user API`,
      set.status === 400 && body.error === "password_not_settable",
      `got ${set.status} ${body.error ?? ""}`,
    );
    check(`…and ${label} stored password is unchanged`, before?.passwordHash === after?.passwordHash);
  }
}

async function concurrentHeartbeatsOpenOneShift(): Promise<void> {
  section("QA-04  Tabs heartbeating at the same moment open one shift, not several");

  const agent = await makeUser("AGENT", "beat");
  const cookie = await sessionCookie(agent.id);

  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      fetch(`${BASE_URL}/api/work-session/heartbeat`, {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie },
      }),
    ),
  );
  check("every heartbeat is answered 200", responses.every((r) => r.status === 200), responses.map((r) => r.status).join(","));

  const open = await prisma.workSession.count({ where: { userId: agent.id, endedAt: null } });
  check("exactly one open work session exists", open === 1, `${open} open rows`);
}

async function parallelGuessesAreThrottled(): Promise<void> {
  section("QA-05  A parallel burst of wrong passwords stops at the throttle's limit");

  // Sign-in: twenty wrong passwords at once, each from its own address, so it
  // is the per-account window (8) that is being measured.
  const target = await makeUser("AGENT", "burst");
  const burst = await Promise.all(
    Array.from({ length: 20 }, () => post("/api/auth/login", { username: target.username, password: "wrong-password-guess" })),
  );
  const guessed = burst.filter((r) => r.status === 401).length;
  const refused = burst.filter((r) => r.status === 429).length;
  check(
    "at most 8 of 20 parallel wrong passwords are checked; the rest get 429",
    guessed <= 8 && guessed + refused === 20,
    `${guessed} checked (401), ${refused} refused (429)`,
  );
  const after = await post("/api/auth/login", { username: target.username, password: PASSWORD });
  check("the account is locked to further attempts, even the right password", after.status === 429, `got ${after.status}`);

  // Changing a password: the same race, behind a session.
  const owner = await makeUser("AGENT", "pwburst");
  const cookie = await sessionCookie(owner.id);
  const changes = await Promise.all(
    Array.from({ length: 20 }, () =>
      post(
        "/api/account/password",
        { currentPassword: "not-the-current-one", newPassword: "a-brand-new-Pa55phrase", confirmPassword: "a-brand-new-Pa55phrase" },
        { Cookie: cookie },
      ),
    ),
  );
  const checked = changes.filter((r) => r.status === 400).length;
  check(
    "at most 8 of 20 parallel wrong current passwords are checked",
    checked <= 8 && changes.filter((r) => r.status === 429).length === 20 - checked,
    `${checked} checked, statuses ${[...new Set(changes.map((r) => r.status))].join(",")}`,
  );

  // And an ordinary sign-in from a fresh account still works.
  const fine = await makeUser("AGENT", "fine");
  const ok = await post("/api/auth/login", { username: fine.username, password: PASSWORD });
  check("an unrelated account still signs in", ok.status === 200, `got ${ok.status}`);
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(`Auth hardening — against ${BASE_URL}`);
  try {
    await revokedSessionLandsOnLogin();
    await otpGuessesAreBounded();
    await monitorDiesWithPassword();
    await concurrentHeartbeatsOpenOneShift();
    await parallelGuessesAreThrottled();
  } finally {
    // Reset codes keep the issuing administrator by a RESTRICT key.
    await prisma.passwordReset
      .deleteMany({ where: { OR: [{ userId: { in: createdUsers } }, { issuedById: { in: createdUsers } }] } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch((error) => {
      console.error("cleanup failed:", error);
    });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
