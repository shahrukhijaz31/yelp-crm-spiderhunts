import { HOME_PATH, safeCallbackUrl } from "./access";

/**
 * The login form's view of authentication.
 *
 * One function, called from the browser, wrapping `POST /api/auth/login`. The
 * route does the real work — password verification, throttling, minting the
 * session — and sets an HttpOnly cookie the client cannot read. Nothing about
 * the session is returned here on purpose: this module knows only whether the
 * attempt succeeded and where to go next, so there is no user object floating
 * around the client that could be mistaken for authority.
 *
 * The error codes are the form's vocabulary. Each maps to one sentence in
 * `AUTH_ERROR_MESSAGES`, and every failure path ends at one of them, so the
 * form never has to invent a message from an HTTP status.
 */

export type AuthErrorCode =
  | "invalid_credentials"
  | "account_disabled"
  | "password_change_required"
  | "too_many_attempts"
  | "network"
  | "server";

export type SignInResult = { ok: true; redirectTo: string } | { ok: false; code: AuthErrorCode };

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
  network: "Could not reach the server. Check your connection and try again.",
  server: "Something went wrong on our end. Try again in a moment.",
};

/** HTTP status / error code -> the form's vocabulary. */
function codeFor(status: number, error: unknown): AuthErrorCode {
  if (error === "account_disabled") return "account_disabled";
  if (error === "password_change_required") return "password_change_required";
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
  };

  if (!response.ok) return { ok: false, code: codeFor(response.status, payload.error) };

  // Sanitised again on arrival. The server already did, and this costs nothing
  // — a redirect target that has been through the network is worth re-checking
  // before it is handed to the router.
  return {
    ok: true,
    redirectTo: safeCallbackUrl(
      typeof payload.redirectTo === "string" ? payload.redirectTo : HOME_PATH,
    ),
  };
}
