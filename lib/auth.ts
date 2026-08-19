import { HOME_PATH, safeCallbackUrl } from "./access";
import type { PendingChallenge } from "./otpRules";

/**
 * The login screen's view of authentication.
 *
 * Four functions, called from the browser, wrapping the four endpoints a
 * sign-in now touches: `login`, then `otp/verify`, `otp/resend` and
 * `otp/cancel`. The routes do all the real work — password verification,
 * throttling, checking the emailed code, minting the session — and the session
 * arrives as an HttpOnly cookie the client cannot read.
 *
 * **Nothing here decides anything.** `signIn` returning `otpRequired` is a
 * statement about what the server did, not a permission: the client cannot skip
 * the second step, because the first one never created a session to skip *to*.
 * And no function in this file ever sees a verification code except as the
 * string the user typed, on its way out — the comparison happens in Postgres's
 * neighbourhood, never here.
 *
 * The error codes are the form's vocabulary. Each maps to one sentence in
 * `AUTH_ERROR_MESSAGES` or `OTP_ERROR_MESSAGES`, and every failure path ends at
 * one of them, so the form never has to invent a message from an HTTP status.
 */

export type AuthErrorCode =
  | "invalid_credentials"
  | "account_disabled"
  | "password_change_required"
  | "too_many_attempts"
  | "email_failed"
  | "network"
  | "server";

export type SignInResult =
  /** The password was right and a code is in the post. Every role takes this path. */
  | { ok: true; otpRequired: true; redirectTo: string; challenge: PendingChallenge }
  /**
   * The password was right and that was the whole sign-in — a session already
   * exists. **No account reaches this any more.** It described the administrator
   * bypass in `app/api/auth/login/route.ts`, which has been removed; the variant
   * is kept because it costs nothing and because a client that stops handling it
   * would be a client that breaks silently if the server ever answers this way
   * again.
   *
   * The two are told apart by `otpRequired` rather than by the presence of
   * `challenge`, so the branch is on a field that is always there. A client
   * that got this wrong would send someone to the portal without a session and
   * be bounced straight back by the guards — it cannot manufacture access,
   * because the server decided this before answering.
   */
  | { ok: true; otpRequired: false; redirectTo: string }
  | { ok: false; code: AuthErrorCode };

export interface Credentials {
  username: string;
  password: string;
  /** Where the user was headed before being sent here. Sanitised server-side too. */
  callbackUrl?: string;
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  // Names neither field: telling someone the username exists but the password
  // is wrong tells that to anyone guessing, too.
  invalid_credentials: "Incorrect username or password. Check both and try again.",
  account_disabled: "This account has been disabled. Contact your administrator.",
  password_change_required:
    "Your password was reset. Use “Forgot your password?” below and enter the reset code your administrator gave you.",
  too_many_attempts: "Too many sign-in attempts. Try again in a few minutes.",
  // Deliberately does not say "contact your administrator". Since the ADMIN OTP
  // bypass was removed, an administrator can meet this message too — and telling
  // them to contact themselves is the point at which error copy stops helping.
  // It names the thing that is actually broken instead, which is the same advice
  // for both roles: someone has to fix mail delivery on the server. Only a
  // caller who has already supplied a correct password ever reads it.
  email_failed:
    "We could not send your verification code. Try again in a moment — if it keeps failing, the portal's email delivery needs fixing on the server.",
  network: "Could not reach the server. Check your connection and try again.",
  server: "Something went wrong on our end. Try again in a moment.",
};

/** HTTP status / error code -> the form's vocabulary. */
function codeFor(status: number, error: unknown): AuthErrorCode {
  if (error === "account_disabled") return "account_disabled";
  if (error === "password_change_required") return "password_change_required";
  if (error === "email_failed") return "email_failed";
  if (status === 429) return "too_many_attempts";
  if (status === 401 || status === 400) return "invalid_credentials";
  return "server";
}

export async function signIn(credentials: Credentials): Promise<SignInResult> {
  let response: Response;
  try {
    response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `same-origin` is the default, stated because it matters: the session
      // cookie comes back on this response and must be stored.
      credentials: "same-origin",
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        callbackUrl: credentials.callbackUrl ?? HOME_PATH,
      }),
    });
  } catch {
    return { ok: false, code: "network" };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    redirectTo?: unknown;
    otpRequired?: unknown;
    challenge?: PendingChallenge;
  };

  if (!response.ok) return { ok: false, code: codeFor(response.status, payload.error) };

  // Sanitised again on arrival. The server already did, and this costs nothing
  // — a redirect target that has been through the network is worth re-checking
  // before it is handed to the router.
  const redirectTo = safeCallbackUrl(
    typeof payload.redirectTo === "string" ? payload.redirectTo : HOME_PATH,
  );

  // The admin path: signed in already, nothing further to do.
  if (payload.otpRequired === false) return { ok: true, otpRequired: false, redirectTo };

  // A code was required but no challenge came back. That cannot happen — the
  // route issues one before answering — but treating it as a server error is
  // the only safe reading: the alternative is a verification screen with
  // nothing to verify against and no way forward.
  if (!payload.challenge) return { ok: false, code: "server" };

  return { ok: true, otpRequired: true, redirectTo, challenge: payload.challenge };
}

/* ========================================================================== *
 * Step two: the emailed code.
 * ========================================================================== */

export type OtpErrorCode =
  | "invalid_code"
  | "expired"
  | "too_many_attempts"
  | "account_disabled"
  | "no_pending"
  | "network"
  | "server";

export const OTP_ERROR_MESSAGES: Record<OtpErrorCode, string> = {
  invalid_code: "That code is not correct. Check the digits and try again.",
  expired: "That code has expired. Request a new one to continue.",
  too_many_attempts:
    "Too many incorrect codes. That code has been cancelled — request a new one.",
  account_disabled: "This account has been disabled. Contact your administrator.",
  // Reached when the pending sign-in is gone: the browser was closed, the code
  // was already used, or five minutes passed with the tab open.
  no_pending: "Your sign-in timed out. Enter your username and password again.",
  network: "Could not reach the server. Check your connection and try again.",
  server: "Something went wrong on our end. Try again in a moment.",
};

export type VerifyOtpResult =
  | { ok: true; redirectTo: string }
  | { ok: false; code: OtpErrorCode; attemptsRemaining?: number };

/**
 * Submit the code. A success here is a real session — this is the call the
 * whole screen exists to make.
 *
 * The code goes out in the body of a POST and nowhere else: not into the URL,
 * not into storage, not into a cookie. Whatever the user typed is held in React
 * state only long enough to send it, because the state is what fills the boxes
 * on the screen — it is never consulted to decide anything, and the server's
 * answer is the only thing that moves the screen forward.
 */
export async function verifyOtp(input: {
  code: string;
  callbackUrl?: string;
}): Promise<VerifyOtpResult> {
  let response: Response;
  try {
    response = await fetch("/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        code: input.code,
        callbackUrl: input.callbackUrl ?? HOME_PATH,
      }),
    });
  } catch {
    return { ok: false, code: "network" };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    redirectTo?: unknown;
    attemptsRemaining?: unknown;
  };

  if (!response.ok) {
    const known: readonly string[] = [
      "invalid_code",
      "expired",
      "too_many_attempts",
      "account_disabled",
      "no_pending",
    ];
    return {
      ok: false,
      code: (typeof payload.error === "string" && known.includes(payload.error)
        ? payload.error
        : "server") as OtpErrorCode,
      attemptsRemaining:
        typeof payload.attemptsRemaining === "number" ? payload.attemptsRemaining : undefined,
    };
  }

  return {
    ok: true,
    redirectTo: safeCallbackUrl(
      typeof payload.redirectTo === "string" ? payload.redirectTo : HOME_PATH,
    ),
  };
}

export type ResendErrorCode =
  | "no_pending"
  | "cooldown"
  | "too_many_sends"
  | "email_failed"
  | "network"
  | "server";

export type ResendOtpResult =
  | { ok: true; challenge: PendingChallenge }
  | { ok: false; code: ResendErrorCode; retryAfterSeconds?: number };

export const RESEND_ERROR_MESSAGES: Record<ResendErrorCode, string> = {
  no_pending: OTP_ERROR_MESSAGES.no_pending,
  cooldown: "Wait a moment before requesting another code.",
  too_many_sends:
    "You have requested too many codes. Start again from the sign-in form, or contact your administrator.",
  email_failed: "We could not send a new code. Try again in a moment.",
  network: OTP_ERROR_MESSAGES.network,
  server: OTP_ERROR_MESSAGES.server,
};

/**
 * Ask for a fresh code.
 *
 * Sends no body: the server sends to the registered address of whoever the
 * pending cookie resolves to, and there is nothing in this request that could
 * redirect it elsewhere.
 */
export async function resendOtp(): Promise<ResendOtpResult> {
  let response: Response;
  try {
    response = await fetch("/api/auth/otp/resend", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, code: "network" };
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    challenge?: PendingChallenge;
    retryAfterSeconds?: unknown;
  };

  if (!response.ok || !payload.challenge) {
    const known: readonly string[] = ["no_pending", "cooldown", "too_many_sends", "email_failed"];
    return {
      ok: false,
      code: (typeof payload.error === "string" && known.includes(payload.error)
        ? payload.error
        : "server") as ResendErrorCode,
      retryAfterSeconds:
        typeof payload.retryAfterSeconds === "number" ? payload.retryAfterSeconds : undefined,
    };
  }

  return { ok: true, challenge: payload.challenge };
}

/**
 * Abandon the sign-in — what "Back to login" calls before showing the password
 * form again. Best-effort: the code expires on its own in five minutes anyway,
 * so a failure here costs nothing and must not block the user going back.
 */
export async function cancelOtp(): Promise<void> {
  await fetch("/api/auth/otp/cancel", { method: "POST", credentials: "same-origin" }).catch(
    () => {},
  );
}
