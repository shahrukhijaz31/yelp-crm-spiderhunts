/**
 * The single seam between the login form and whatever ends up authenticating.
 *
 * The portal has no user store: every browser route sits behind the nginx
 * Basic Auth described in `deploy/nginx/leadportal.conf`, and the one route
 * that authenticates itself does so with a bearer token (`lib/ingestAuth.ts`).
 * So there is nothing here to check a password against yet, and inventing one
 * would mean shipping a credential check that looks real and protects nothing.
 *
 * What this module is instead: the shape the real call will have. The form
 * knows only `signIn` and the codes below, so wiring a backend later is a
 * change to this file and nowhere else —
 *
 *   const response = await fetch("/api/auth/login", {
 *     method: "POST",
 *     headers: { "content-type": "application/json" },
 *     body: JSON.stringify({ username, password }),
 *   });
 *   if (response.ok) return { ok: true };
 *   return { ok: false, code: response.status === 401 ? "invalid_credentials" : "server" };
 *
 * Until then, no credential is a valid one, so every attempt is genuinely
 * `invalid_credentials` rather than a pretend success.
 */

export type AuthErrorCode = "invalid_credentials" | "network" | "server";

export type SignInResult = { ok: true } | { ok: false; code: AuthErrorCode };

export interface Credentials {
  username: string;
  password: string;
}

/**
 * One message per failure, written for the person at the keyboard.
 *
 * `invalid_credentials` deliberately names neither field: telling someone the
 * username exists but the password is wrong tells that to anyone guessing.
 */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: "Incorrect username or password. Check both and try again.",
  network: "Could not reach the server. Check your connection and try again.",
  server: "Something went wrong on our end. Try again in a moment.",
};

export async function signIn(credentials: Credentials): Promise<SignInResult> {
  // Nothing reads these yet — the fetch above is where they start mattering.
  void credentials;
  // Stands in for the round trip, so the submitting state is real rather than
  // a frame long. Remove it with the fetch above.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { ok: false, code: "invalid_credentials" };
}
