import { safeCallbackUrl } from "@/lib/access";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { hashPassword, verifyPassword } from "@/lib/password";
import { createSession, pruneExpiredSessions } from "@/lib/session";
import { findUserForLogin, markLoggedIn } from "@/lib/userDb";

/**
 * POST /api/auth/login — exchange a username and password for a session.
 *
 * The one route that turns an anonymous request into an identified one, so it
 * is the one route where the details matter most:
 *
 *   - Wrong username and wrong password are the same answer, `invalid`, with
 *     the same timing. A login form that answers faster for accounts that do
 *     not exist is an account enumeration endpoint.
 *   - A brand-new session token is minted here and only here, so a token the
 *     client already held can never be promoted to an authenticated one
 *     (session fixation).
 *   - Failures are counted (`lib/loginThrottle`) before any password work is
 *     done, so a locked-out attacker cannot even make the server spend scrypt
 *     time.
 *
 * The response carries no user data. The client reloads and the server renders
 * the portal for whoever the session says they are; sending the role back here
 * would invite someone to treat that JSON as authoritative.
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
    { error: "invalid_credentials", message: "Incorrect username or password." },
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
      { status: 400 },
    );
  }

  const payload = body as { username?: unknown; password?: unknown; callbackUrl?: unknown };
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  // The destination is decided here, from a value the browser supplied, so it
  // goes through the same sanitiser the proxy uses. An unchecked value here is
  // an open redirect with a login page in front of it.
  const redirectTo = safeCallbackUrl(
    typeof payload.callbackUrl === "string" ? payload.callbackUrl : null,
  );

  if (!username || !password) {
    return Response.json(
      { error: "missing_fields", message: "Enter your username and password." },
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
    console.error("POST /api/auth/login: database lookup failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. Try again in a moment.",
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

  // Checked *after* the password, on purpose: a disabled account gets a clear
  // answer, but only to someone who already knew its password. Checking first
  // would turn the endpoint into a way to test which accounts exist.
  if (!user.isActive) {
    return Response.json(
      {
        error: "account_disabled",
        message: "This account has been disabled. Contact your administrator.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The forced-password-change state, enforced at the door.
  //
  // In practice this is unreachable: issuing a reset code replaces the account's
  // hash with one nobody holds the preimage of, so a user in this state has no
  // password that verifies and never gets this far. It is checked anyway,
  // because "must change password" should be a property of *signing in* rather
  // than a side effect of how the reset happened to be implemented — if some
  // future path ever sets the flag on an account whose password still works,
  // the flag will still mean what it says.
  if (user.requirePasswordChange) {
    return Response.json(
      {
        error: "password_change_required",
        message:
          "Your password was reset. Use the reset code from your administrator to set a new one.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    await createSession(user.id, {
      userAgent: request.headers.get("user-agent"),
      ipAddress: ip,
    });
  } catch (error) {
    console.error("POST /api/auth/login: could not create session:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Signed in, but the session could not be saved. Try again.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  clearLoginFailures(username);
  await markLoggedIn(user.id);
  // Opportunistic housekeeping — this app has no cron, and a login is a
  // natural, infrequent moment to clear out rows whose clocks have run out.
  void pruneExpiredSessions();

  return Response.json({ ok: true, redirectTo }, { headers: { "Cache-Control": "no-store" } });
}
