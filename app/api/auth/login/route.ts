import { safeCallbackUrl } from "@/lib/access";
import { issueLoginOtp } from "@/lib/loginOtp";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { isMailConfigured } from "@/lib/mail";
import { hashPassword, verifyPassword } from "@/lib/password";
import { findUserForLogin } from "@/lib/userDb";

/**
 * POST /api/auth/login — check a username and password, then email a code.
 *
 * **Nobody is signed in by this route.** Every path ends at `issueLoginOtp`,
 * and the session is minted by `POST /api/auth/otp/verify` once the emailed
 * code comes back.
 *
 * That now includes administrators. The role used to finish here on the
 * password alone, through a marked bypass block; the second factor was switched
 * back on for every role at the client's request, and the block is gone rather
 * than commented out — one path, no role test, nothing to re-enable by
 * accident. `landingRedirectFor` moved with it to the verify route, which is
 * where every sign-in now ends.
 *
 * **The cost of that, stated plainly: no mail, no sign-in, for anyone.** The
 * account that used to be able to get in and repair the mail settings was the
 * administrator, and it cannot any more. See the `isMailConfigured` guard
 * below, which is now the whole front door.
 *
 * Everything before the code is issued is untouched, because it was already
 * right:
 *
 *   - Wrong username and wrong password are the same answer, `invalid`, with
 *     the same timing. A login form that answers faster for accounts that do
 *     not exist is an account enumeration endpoint.
 *   - Failures are counted (`lib/loginThrottle`) before any password work is
 *     done, so a locked-out attacker cannot even make the server spend scrypt
 *     time.
 *   - Disabled and must-change-password accounts are refused *after* the
 *     password check, so a clear answer reaches only someone who already knew
 *     the password.
 *
 * What the split buys is that a correct password produces
 * no authority at all. The pending state it leaves behind is a row in
 * `login_otps` and a browser-session cookie that names nobody
 * (`lib/loginOtp.ts`); no guard in the app reads either, so there is no version
 * of "half signed in" that any protected page or route can be tricked into
 * honouring.
 *
 * The response still carries no user data — only the masked address the code
 * went to, and the two clocks the screen counts down from.
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

  /*
   * The password is right. Everything that used to happen here — the session,
   * `markLoggedIn`, the work-session clock, the housekeeping — has moved to
   * `POST /api/auth/otp/verify`, so that none of it can happen to somebody who
   * has a password and not the mailbox.
   *
   * The throttle record is cleared at this point rather than at the end, and
   * that is deliberate: the identifier window exists to stop password guessing,
   * and the password has just been guessed correctly. Leaving it armed would
   * mean an agent who mistyped their password four times could be locked out
   * *between* the two steps of their own successful sign-in. Guessing at the
   * code is bounded by its own, tighter limits (five attempts, five minutes,
   * one use) inside `lib/loginOtp.ts`.
   */
  clearLoginFailures(username);

  /*
   * Checked here rather than at the top of the route, and only once there is
   * something to send: without SMTP no code can be sent, and this route must
   * never fall back to issuing a session on the password alone.
   *
   * It now fails closed for **every** account, administrators included. That is
   * the deliberate consequence of requiring a second factor of the role that
   * used to be exempt, and it is worth being explicit about: while SMTP is
   * broken, nobody can sign in to this portal at all, and the way back in is
   * server access — fix the mail settings, or mint a session row by hand — not
   * a login form. The alternative is an administrator password that is a single
   * factor forever, which is the thing this change was asked to remove.
   *
   * Checked after the password, not before, so a caller who does not already
   * hold a valid password learns nothing about the mail configuration.
   */
  if (!isMailConfigured()) {
    console.error("POST /api/auth/login: SMTP is not configured; sign-in refused.");
    return Response.json(
      {
        error: "email_failed",
        message:
          "Verification codes cannot be sent, so nobody can sign in until the portal's email delivery is fixed on the server.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const issued = await issueLoginOtp({ id: user.id, email: user.email }).catch(
    (error: unknown) => {
      console.error("POST /api/auth/login: could not issue a verification code:", error);
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

  /*
   * `otpRequired` is stated rather than implied. The client has one code path
   * for "the password was accepted", and it is this one — there is no branch in
   * which a 200 from this route means a session exists, so a client that
   * ignored the flag would still hold nothing.
   *
   * `redirectTo` is echoed back so the verification screen can carry the
   * original destination through to the second step. It has already been
   * sanitised above and is sanitised again when it comes back.
   */
  return Response.json(
    { ok: true, otpRequired: true, redirectTo, challenge: issued.challenge },
    { headers: { "Cache-Control": "no-store" } },
  );
}
