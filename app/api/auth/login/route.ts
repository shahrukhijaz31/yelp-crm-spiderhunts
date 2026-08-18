import { safeCallbackUrl } from "@/lib/access";
import { landingRedirectFor } from "@/lib/moduleAccess";
import { completeSignIn } from "@/lib/completeSignIn";
import { issueLoginOtp, pruneExpiredLoginOtps } from "@/lib/loginOtp";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { isMailConfigured } from "@/lib/mail";
import { hashPassword, verifyPassword } from "@/lib/password";
import { pruneExpiredSessions } from "@/lib/session";
import { findUserForLogin } from "@/lib/userDb";
import { reconcileStaleWorkSessions } from "@/lib/workSessions";

/**
 * POST /api/auth/login — check a username and password, then either email a
 * code or (for administrators) finish the sign-in.
 *
 * **An AGENT is not signed in by this route.** Their path ends at
 * `issueLoginOtp`, and the session is minted by `POST /api/auth/otp/verify`
 * once the emailed code comes back.
 *
 * **An ADMIN currently is**, via the clearly-marked bypass block below — the
 * second factor is switched off for that role at the client's request, and the
 * block is written so that switching it back on means deleting the block and
 * nothing else.
 *
 * Everything before that fork is untouched, because everything before it was
 * already right:
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
 * What the split buys, on the agent path, is that a correct password produces
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

  /* ======================================================================= *
   * ADMIN OTP BYPASS — administrators sign in on the password alone.
   *
   * Turned off for admins at the client's request, and written as one
   * self-contained block so it can be switched back on by deleting it (or
   * commenting it out) and nothing else. Everything the second factor needs is
   * still here and still working: the table, the routes, the email, the screen.
   * Only this early return stands between an ADMIN and the OTP step, and the
   * AGENT path below is untouched.
   *
   * TO REQUIRE OTP FOR ADMINISTRATORS AGAIN: comment out or delete this whole
   * block, from the `if` to the closing brace. Nothing else changes — the OTP
   * path below already handles every role, and the client already handles a
   * response with `otpRequired: true` for any account.
   *
   * Note what this deliberately does NOT do: it does not weaken anything for
   * agents, and it does not give an administrator a *different* session. Both
   * roles land in `completeSignIn`, so an admin session is minted, clocked and
   * expired exactly as it has always been — the only difference is how many
   * factors were checked on the way in.
   * ======================================================================= */
  if (user.role === "ADMIN") {
    try {
      await completeSignIn(user.id, {
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

    // The same opportunistic housekeeping the OTP route runs, because for an
    // administrator this *is* the end of the sign-in.
    void pruneExpiredSessions();
    void reconcileStaleWorkSessions();
    void pruneExpiredLoginOtps();

    // `otpRequired: false` is stated rather than left to be inferred from a
    // missing `challenge`: the client branches on this one field, so the two
    // outcomes of this route are told apart by a value that is always present.
    return Response.json(
      // Where an account with no requested destination actually belongs. For an
      // administrator that is always the worklist; the call is made anyway so
      // both sign-in routes answer this question in one place, and so a future
      // module cannot be added to one path and forgotten on the other. See
      // `landingRedirectFor`.
      { ok: true, otpRequired: false, redirectTo: await landingRedirectFor(user.id, redirectTo) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  /* ===================== end ADMIN OTP BYPASS ============================ */

  /*
   * Checked here rather than at the top of the route, and only on the path that
   * actually needs to send something: without SMTP no code can be sent, and
   * this route must never fall back to issuing a session on the password alone.
   * It fails closed for the accounts that require a code — and leaves an
   * administrator able to sign in and fix the mail settings, which is the one
   * account you want working when mail is down.
   */
  if (!isMailConfigured()) {
    console.error("POST /api/auth/login: SMTP is not configured; sign-in refused.");
    return Response.json(
      {
        error: "email_failed",
        message: "Verification codes cannot be sent right now. Contact your administrator.",
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
