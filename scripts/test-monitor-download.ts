import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import { monitorRelease } from "../lib/monitorRelease";

/**
 * End-to-end check of the SpiderHunts Monitor download: who may fetch the
 * installer, what comes back, what happens when it is missing, and what an
 * agent cannot ask for — against a running server and a real database.
 *
 *   npm run dev                    (in one terminal)
 *   npm run test:monitor-download  (in another)
 *
 * Written in the shape `test-app-usage.ts` established, and for the same
 * reason: this repository has no test framework, and none of the claims worth
 * checking here are unit-testable in any useful sense. "An unauthenticated
 * request cannot download the installer" is a claim about a proxy, a route
 * handler, a session cookie and a database lookup — a mocked version would pass
 * whether or not the real thing works.
 *
 * It creates a throwaway agent and administrator (`dltest-*`) and deletes both
 * on the way out, including after a failure. It touches no existing user or
 * session, and it never deletes an installer it did not itself create.
 *
 * **Portal sessions are inserted directly rather than signed in for.** A real
 * sign-in needs a six-digit code delivered by email, which a test cannot read.
 * The token construction is copied from `lib/session.ts` (32 random bytes,
 * SHA-256 into the row), so what the routes authenticate is exactly what they
 * authenticate in production.
 *
 * The last section re-checks the *existing* systems — leads, screenshots, time
 * tracking, the monitor session endpoint and the admin/agent boundary — to show
 * that adding a download page changed none of them.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "monitor-download-test-Pa55phrase";

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

const RELEASE = monitorRelease();

/**
 * Where the server will look, worked out the same way `lib/monitorRelease.ts`
 * does. Duplicated deliberately rather than exported from there: the point of
 * this file is to check the real path resolution from the outside, and a shared
 * helper would make a wrong default agree with itself.
 */
const INSTALLER_PATH = process.env.MONITOR_INSTALLER_PATH?.trim()
  ? path.resolve(process.env.MONITOR_INSTALLER_PATH.trim())
  : path.resolve(process.cwd(), ".data/downloads", RELEASE.fileName);

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

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
      userAgent: "monitor-download-test",
      ipAddress: "127.0.0.1",
    },
  });

  return `${SESSION_COOKIE}=${token}`;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

async function raw(
  url: string,
  cookie?: string,
  method = "GET",
): Promise<Response> {
  return fetch(`${BASE_URL}${url}`, {
    method,
    headers: cookie ? { cookie } : {},
    // The portal redirects unauthenticated *pages*; the API answers 401. Either
    // way a redirect must not be followed, or the status under test is lost.
    redirect: "manual",
  });
}

async function json(
  url: string,
  cookie?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await raw(url, cookie);
  try {
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: {} };
  }
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const created: string[] = [];
/** True only when this run put the installer there, so cleanup can be honest. */
let installerIsOurs = false;

async function main(): Promise<void> {
  console.log(`Monitor download checks against ${BASE_URL}`);
  console.log(`Release ${RELEASE.version}, expecting ${RELEASE.fileName}\n`);

  const stamp = Date.now();
  const passwordHash = await hashPassword(PASSWORD);

  const agent = await prisma.user.create({
    data: {
      username: `dltest-agent-${stamp}`,
      email: `dltest-agent-${stamp}@example.test`,
      name: "Download Test Agent",
      passwordHash,
      role: "AGENT",
    },
    select: { id: true },
  });
  created.push(agent.id);

  const admin = await prisma.user.create({
    data: {
      username: `dltest-admin-${stamp}`,
      email: `dltest-admin-${stamp}@example.test`,
      name: "Download Test Admin",
      passwordHash,
      role: "ADMIN",
    },
    select: { id: true },
  });
  created.push(admin.id);

  const agentCookie = await signIn(agent.id);
  const adminCookie = await signIn(admin.id);

  /* --- 1. The installer is missing -------------------------------------- */
  /*
   * Run first, and only when there is genuinely nothing at the configured path.
   * A box that already has a real installer keeps it: deleting 77MB belonging
   * to somebody else to prove a 404 is not a trade worth making.
   */
  section("A missing installer");

  const preexisting = await fileSize(INSTALLER_PATH);

  if (preexisting === null) {
    const missing = await json("/api/downloads/monitor", agentCookie);
    check("the download answers 404 when the installer is absent", missing.status === 404);
    check(
      "the message is the one an agent should see",
      typeof missing.body.message === "string" &&
        (missing.body.message as string).includes("temporarily unavailable"),
    );
    check(
      "no filesystem path is disclosed",
      !JSON.stringify(missing.body).includes("/") &&
        !JSON.stringify(missing.body).includes("\\"),
      JSON.stringify(missing.body),
    );

    const info = await json("/api/downloads/monitor/info", agentCookie);
    check("the metadata endpoint reports it as unavailable", info.body.available === false);
    check(
      "the metadata endpoint discloses no path",
      !("path" in info.body) && !JSON.stringify(info.body).includes(INSTALLER_PATH),
    );

    // Now put one there, so everything below has a file to fetch. Small, and
    // starting with the two bytes a Windows executable starts with.
    await mkdir(path.dirname(INSTALLER_PATH), { recursive: true });
    await writeFile(INSTALLER_PATH, FAKE_INSTALLER);
    installerIsOurs = true;
    console.log(`  ..    wrote a ${FAKE_INSTALLER.byteLength}-byte stand-in installer`);
  } else {
    skip(
      "the missing-installer case",
      `an installer is already present (${preexisting} bytes); it will not be deleted`,
    );
  }

  const expectedSize = (await fileSize(INSTALLER_PATH)) ?? 0;

  /* --- 2. Who may download ---------------------------------------------- */
  section("Access");

  const anonymous = await raw("/api/downloads/monitor");
  check("an unauthenticated download is refused", anonymous.status === 401, `got ${anonymous.status}`);
  const anonymousInfo = await raw("/api/downloads/monitor/info");
  check("unauthenticated metadata is refused", anonymousInfo.status === 401);
  const anonymousPage = await raw("/downloads");
  check(
    "the page redirects an unauthenticated visitor to sign in",
    anonymousPage.status === 307 || anonymousPage.status === 302,
    `got ${anonymousPage.status}`,
  );

  const forged = await raw("/api/downloads/monitor", `${SESSION_COOKIE}=${randomBytes(32).toString("base64url")}`);
  check("a made-up session token is refused", forged.status === 401, `got ${forged.status}`);

  const agentDownload = await raw("/api/downloads/monitor", agentCookie);
  check("an agent may download", agentDownload.status === 200, `got ${agentDownload.status}`);

  const adminDownload = await raw("/api/downloads/monitor", adminCookie);
  check("an administrator may download", adminDownload.status === 200, `got ${adminDownload.status}`);

  const agentPage = await raw("/downloads", agentCookie);
  check("an agent may open the page", agentPage.status === 200, `got ${agentPage.status}`);

  /* --- 3. What comes back ------------------------------------------------ */
  section("The response");

  check(
    "the content type is the Windows executable type",
    agentDownload.headers.get("content-type") ===
      "application/vnd.microsoft.portable-executable",
    agentDownload.headers.get("content-type") ?? "none",
  );

  const disposition = agentDownload.headers.get("content-disposition") ?? "";
  check("it is an attachment, not something to display", disposition.startsWith("attachment"));
  check(
    `the filename is ${RELEASE.fileName}`,
    disposition.includes(`filename="${RELEASE.fileName}"`) &&
      disposition.includes(encodeURIComponent(RELEASE.fileName)),
    disposition,
  );
  check(
    "the length matches the file on disk",
    agentDownload.headers.get("content-length") === String(expectedSize),
    `${agentDownload.headers.get("content-length")} vs ${expectedSize}`,
  );
  check("sniffing is off", agentDownload.headers.get("x-content-type-options") === "nosniff");
  check(
    "it is not cached anywhere shared",
    (agentDownload.headers.get("cache-control") ?? "").includes("no-store"),
    agentDownload.headers.get("cache-control") ?? "none",
  );

  const bytes = new Uint8Array(await agentDownload.arrayBuffer());
  check("the body is the whole file", bytes.byteLength === expectedSize);
  await adminDownload.arrayBuffer();

  const meta = await json("/api/downloads/monitor/info", agentCookie);
  check("the metadata reports it as available", meta.body.available === true);
  check("the metadata version matches the download", meta.body.version === RELEASE.version);
  check("the metadata filename matches the download", meta.body.fileName === RELEASE.fileName);
  check("the metadata size matches the file", meta.body.sizeBytes === expectedSize);
  check("the metadata names the platform", meta.body.platform === "Windows");
  check(
    "the metadata carries no path and no environment",
    !JSON.stringify(meta.body).includes(INSTALLER_PATH) &&
      !JSON.stringify(meta.body).includes("MONITOR_INSTALLER_PATH"),
  );

  /* --- 4. What cannot be asked for --------------------------------------- */
  /*
   * The route takes no parameter of any kind, so these are not so much
   * "traversal is blocked" as "there is nothing to traverse with". Checked
   * anyway, because that property is exactly the one a later feature quietly
   * breaks by adding a `?file=` for convenience.
   */
  section("Nothing else can be requested");

  for (const attempt of [
    "/api/downloads/monitor?file=../../../../etc/passwd",
    "/api/downloads/monitor?path=/etc/passwd",
    "/api/downloads/monitor?name=.env",
  ]) {
    const response = await raw(attempt, agentCookie);
    const body = new Uint8Array(await response.arrayBuffer());
    check(
      `a query parameter changes nothing (${attempt.split("?")[1]})`,
      response.status === 200 && body.byteLength === expectedSize,
      `${response.status}, ${body.byteLength} bytes`,
    );
  }

  for (const attempt of [
    "/api/downloads/monitor/anything.exe",
    "/api/downloads/monitor/..%2F..%2F.env",
    "/api/downloads/.env",
    "/api/downloads",
  ]) {
    const response = await raw(attempt, agentCookie);
    await response.arrayBuffer();
    check(
      `there is no route at ${attempt}`,
      response.status === 404,
      `got ${response.status}`,
    );
  }

  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await raw("/api/downloads/monitor", adminCookie, method);
    await response.arrayBuffer();
    check(
      `${method} is not a thing anyone can do, including an administrator`,
      response.status === 405,
      `got ${response.status}`,
    );
  }

  /* --- 5. Everything that already worked, still works --------------------- */
  section("The rest of the portal is unchanged");

  check(
    "an agent can still read the lead list",
    (await json("/api/leads?page=1", agentCookie)).status === 200,
  );
  check(
    "an agent still cannot read the screenshot viewer",
    (await json("/api/screenshots", agentCookie)).status === 403,
  );
  check(
    "an administrator still can",
    (await json("/api/screenshots", adminCookie)).status === 200,
  );
  check(
    "an agent still cannot read app usage",
    (await json("/api/reports/app-usage", agentCookie)).status === 403,
  );
  check(
    "an agent can still read their own time tracking",
    (await json("/api/time-tracking/me", agentCookie)).status === 200,
  );
  check(
    "an agent still cannot list users",
    (await json("/api/users", agentCookie)).status === 403,
  );
  check(
    "the monitor session endpoint still refuses an unauthenticated caller",
    (await json("/api/monitor/session")).status === 401,
  );
  check("health is still public", (await json("/api/health")).status === 200);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/** A tiny stand-in installer: `MZ`, then padding. Never overwrites a real one. */
const FAKE_INSTALLER = Buffer.concat([
  Buffer.from("MZ"),
  Buffer.from("SpiderHunts Monitor test stand-in — not an installer.\n"),
]);

async function fileSize(target: string): Promise<number | null> {
  try {
    const info = await stat(target);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Remove everything this run created: the sessions and the two accounts, and
 * the stand-in installer *only* if this run is what wrote it.
 */
async function cleanup(): Promise<void> {
  if (installerIsOurs) {
    await rm(INSTALLER_PATH, { force: true }).catch(() => {});
  }

  if (created.length === 0) return;

  await prisma.session.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
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
