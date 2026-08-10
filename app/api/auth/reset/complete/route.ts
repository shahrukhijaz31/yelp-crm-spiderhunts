import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { completeReset, pruneExpiredResetCodes, ResetError } from "@/lib/passwordReset";

/**
 * POST /api/auth/reset/complete — redeem a code for a new password.
 *
 * The code is verified again here, in full, rather than trusted from the
 * verify step: the two calls are independent, so nothing a client did or
 * skipped in between can substitute for holding the code.
 *
 * **No session is created.** A successful reset ends at the sign-in form,
 * where the person logs in with the password they just chose. That is
 * deliberate: this route is reachable without authentication, and having it
 * mint a session would make it a second way into the application, running
 * beside the one in `/api/auth/login` that has the throttling, the disabled
 * account check and the timing equalisation. There is one door.
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
  const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
  const confirmPassword =
    typeof payload.confirmPassword === "string" ? payload.confirmPassword : "";

  if (!username || !code || !newPassword) {
    return Response.json(
      { error: "missing_fields", message: "Fill in every field." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (newPassword !== confirmPassword) {
    return Response.json(
      { error: "mismatch", message: "The new passwords do not match." },
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
    const user = await completeReset(username, code, newPassword);

    clearLoginFailures(throttleKey);
    // Same opportunistic housekeeping the login route does for sessions: this
    // app has no cron, and a completed reset is a natural moment to sweep.
    void pruneExpiredResetCodes();

    console.info(`password reset completed for user ${user.username}`);

    return Response.json(
      { ok: true, username: user.username },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ResetError) {
      // A password that is merely too short is a mistake, not an attempt to
      // break in, and counting it towards a lockout would punish someone who
      // is holding a valid code and typing carefully.
      if (error.code !== "weak_password") recordLoginFailure(throttleKey, ip);
      return Response.json(
        { error: error.code, message: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("POST /api/auth/reset/complete failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not set your new password." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
