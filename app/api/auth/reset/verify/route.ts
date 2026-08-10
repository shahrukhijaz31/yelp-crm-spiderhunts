import {
  checkLoginAllowed,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { checkResetCode, ResetError } from "@/lib/passwordReset";

/**
 * POST /api/auth/reset/verify — is this username and reset code good?
 *
 * Public, because someone redeeming a code by definition cannot sign in. The
 * code is the credential and it is checked against a salted hash here, on the
 * server, every time.
 *
 * This endpoint grants nothing. It returns a name so the next screen can say
 * whose password is being set, and no token, cookie or session — the code is
 * re-verified from scratch when the new password is submitted, so calling this
 * first is a courtesy to the form, not a step that can be skipped for
 * advantage.
 *
 * Throttled on the username, sharing the login brake, because a code with 30
 * bits of entropy is only strong while guessing is expensive.
 */
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

  const payload = body as Record<string, unknown>;
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const code = typeof payload.code === "string" ? payload.code : "";

  if (!username || !code) {
    return Response.json(
      { error: "missing_fields", message: "Enter your username and reset code." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = clientIp(request);
  const throttleKey = `reset:${username.toLowerCase()}`;
  const verdict = checkLoginAllowed(throttleKey, ip);
  if (!verdict.allowed) {
    return Response.json(
      {
        error: "too_many_attempts",
        message: "Too many attempts. Try again in a few minutes.",
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

  try {
    const user = await checkResetCode(username, code);
    return Response.json(
      { ok: true, name: user.name, username: user.username },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ResetError) {
      // Expiry is counted as a failure too. It is only reachable with a real
      // code, but not counting it would leave a free lane for a guesser who
      // happened to find an old one.
      recordLoginFailure(throttleKey, ip);
      return Response.json(
        { error: error.code, message: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("POST /api/auth/reset/verify failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not reach the database." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
