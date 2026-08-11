import { safeCallbackUrl } from "@/lib/access";
import { completeSignIn } from "@/lib/completeSignIn";
import { clearPendingChallenge, pruneExpiredLoginOtps, verifyLoginOtp } from "@/lib/loginOtp";
import { clientIp } from "@/lib/loginThrottle";
import { pruneExpiredSessions } from "@/lib/session";
import { reconcileStaleWorkSessions } from "@/lib/workSessions";

/**
 * POST /api/auth/otp/verify — redeem the emailed code for a real session.
 *
 * This is the route that turns an anonymous request into an identified one for
 * every account that goes through the OTP step — which today is every AGENT.
 * (Administrators currently finish at the login route itself; see the bypass
 * block there.) Both paths call the same `completeSignIn`, so the session a
 * user ends up with is identical either way, and identical to the one they had
 * before the OTP step existed.
 *
 * Roles in particular are untouched: nothing here reads or writes `role`, and
 * the session carries an opaque token, so an agent gets an agent session and an
 * admin gets an admin session for exactly the reason they always did — the
 * database says so.
 *
 * The caller supplies a code and (optionally) where they were headed. It cannot
 * supply *who it is*: the identity comes from the pending challenge cookie,
 * resolved server-side by `verifyLoginOtp`. There is no user id in the request
 * body for anyone to change.
 *
 * The code itself is checked by `verifyLoginOtp` against a scrypt hash. It is
 * not echoed, not logged, and no response distinguishes "wrong digits" in a way
 * that would help anybody guess faster than the five-attempt cap allows.
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

  const payload = body as { code?: unknown; callbackUrl?: unknown };
  const code = typeof payload.code === "string" ? payload.code : "";
  // Sanitised again on the way back in: the value made a round trip through the
  // browser between the two steps, where anything can be substituted for it.
  const redirectTo = safeCallbackUrl(
    typeof payload.callbackUrl === "string" ? payload.callbackUrl : null,
  );

  let result;
  try {
    result = await verifyLoginOtp(code);
  } catch (error) {
    console.error("POST /api/auth/otp/verify: verification failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!result.ok) {
    // The pending state is torn down for every failure that cannot be retried,
    // so the screen has something true to fall back to instead of a box that
    // will never accept anything.
    if (result.code === "too_many_attempts" || result.code === "account_disabled") {
      await clearPendingChallenge().catch(() => {});
    }

    const status =
      result.code === "no_pending" ? 401 : result.code === "account_disabled" ? 403 : 400;

    return Response.json(
      { error: result.code, attemptsRemaining: result.attemptsRemaining },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The code is spent. Clear the pending cookie *before* minting the session so
  // that a failure in between leaves the browser with neither, rather than with
  // a pending challenge it could try to use again.
  await clearPendingChallenge().catch(() => {});

  try {
    await completeSignIn(result.userId, {
      userAgent: request.headers.get("user-agent"),
      ipAddress: clientIp(request),
    });
  } catch (error) {
    console.error("POST /api/auth/otp/verify: could not create session:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Verified, but the session could not be saved. Sign in again.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Opportunistic housekeeping — this app has no cron, and a completed sign-in
  // is a natural, infrequent moment to clear out rows whose clocks have run
  // out. Spent and expired codes join the sweep for the same reason.
  void pruneExpiredSessions();
  void reconcileStaleWorkSessions();
  void pruneExpiredLoginOtps();

  return Response.json({ ok: true, redirectTo }, { headers: { "Cache-Control": "no-store" } });
}
