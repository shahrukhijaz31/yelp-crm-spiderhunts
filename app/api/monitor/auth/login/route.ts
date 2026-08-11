import { issueLoginOtpForChallenge } from "@/lib/loginOtp";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { isMailConfigured } from "@/lib/mail";
import { checkMonitorEligibility } from "@/lib/monitorAuth";
import { hashPassword, verifyPassword } from "@/lib/password";
import type { Role } from "@/lib/access";
import { findUserForLogin } from "@/lib/userDb";

/**
 * POST /api/monitor/auth/login — step one of connecting a workstation.
 *
 * The desktop counterpart of `POST /api/auth/login`, and deliberately a
 * near-copy of it rather than a new idea: same `findUserForLogin`, same
 * `verifyPassword`, same throttle, same order of checks, same refusal to
 * distinguish a wrong username from a wrong password. What differs is only what
 * the two ends can carry — no cookies, so the challenge token comes back in the
 * body — and one rule that is *stricter*, not looser:
 *
 * **There is no bypass here.** The web route lets an ADMIN finish on the
 * password alone (a documented, deliberately removable block). This route
 * refuses administrators outright and requires the emailed code from every
 * account it does admit. A workstation that will later be capturing screenshots
 * is exactly where the second factor should not be optional.
 *
 * **A correct password produces no authority.** Its entire output is a
 * challenge token: 32 random bytes that name nobody, grant nothing, and are
 * useless without the code. The tokens are minted by the verify route and
 * nowhere else.
 */

/** Burned when the account does not exist, so both paths cost the same scrypt run. */
const DUMMY_HASH_INPUT = "no-such-account-timing-equaliser";
let dummyHash: string | null = null;

async function equaliseTiming(password: string): Promise<void> {
  dummyHash ??= await hashPassword(DUMMY_HASH_INPUT);
  await verifyPassword(password, dummyHash);
}

function invalid(): Response {
  return Response.json(
    { error: "invalid_credentials", message: "Incorrect email or password." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const payload = body as { username?: unknown; password?: unknown };
  // The Monitor's form asks for an email; `findUserForLogin` accepts either an
  // email or a username, so an agent who types their username still gets in.
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!username || !password) {
    return Response.json(
      { error: "missing_fields", message: "Enter your email and password." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = clientIp(request);
  const verdict = checkLoginAllowed(username, ip);
  if (!verdict.allowed) {
    return Response.json(
      {
        error: "too_many_attempts",
        message: "Too many sign-in attempts. Try again in a few minutes.",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(verdict.retryAfterSeconds),
        },
      },
    );
  }

  let user;
  try {
    user = await findUserForLogin(username);
  } catch (error) {
    console.error("POST /api/monitor/auth/login: database lookup failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!user) {
    await equaliseTiming(password);
    recordLoginFailure(username, ip);
    return invalid();
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    recordLoginFailure(username, ip);
    return invalid();
  }

  // Everything below is checked *after* the password, on purpose: a clear
  // answer reaches only somebody who already knew it. Checking role or status
  // first would turn this into a way to enumerate accounts.
  const eligibility = checkMonitorEligibility({
    role: user.role as Role,
    isActive: user.isActive,
  });

  if (eligibility === "account_disabled") {
    return Response.json(
      {
        error: "account_disabled",
        message: "This account has been disabled. Contact your administrator.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (eligibility === "role_not_permitted") {
    return Response.json(
      {
        error: "role_not_permitted",
        message: "SpiderHunts Monitor is for agent accounts.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (user.requirePasswordChange) {
    return Response.json(
      {
        error: "password_change_required",
        message: "Your password was reset. Sign in to the portal to set a new one.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Cleared here rather than at the end, for the reason the web route gives:
  // the password has just been guessed correctly, and an agent must not be
  // locked out *between* the two steps of their own successful sign-in.
  // Guessing at the code is bounded by its own tighter limits.
  clearLoginFailures(username);

  if (!isMailConfigured()) {
    console.error("POST /api/monitor/auth/login: SMTP is not configured; sign-in refused.");
    return Response.json(
      {
        error: "email_failed",
        message: "Verification codes cannot be sent right now. Contact your administrator.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const issued = await issueLoginOtpForChallenge({ id: user.id, email: user.email }).catch(
    (error: unknown) => {
      console.error("POST /api/monitor/auth/login: could not issue a code:", error);
      return { ok: false, code: "email_failed" } as const;
    },
  );

  if (!issued.ok) {
    return Response.json(
      {
        error: "email_failed",
        message: "We could not send your verification code. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { ok: true, otpRequired: true, challengeToken: issued.token, challenge: issued.challenge },
    { headers: { "Cache-Control": "no-store" } },
  );
}
