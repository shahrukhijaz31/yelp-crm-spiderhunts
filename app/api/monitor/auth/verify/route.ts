import {
  clearPendingForChallenge,
  pruneExpiredLoginOtps,
  verifyLoginOtpForChallenge,
} from "@/lib/loginOtp";
import { issueDeviceTokens, pruneExpiredDevices } from "@/lib/monitorAuth";

/**
 * POST /api/monitor/auth/verify — redeem the emailed code for device tokens.
 *
 * The one place a workstation becomes connected. It is the desktop mirror of
 * `POST /api/auth/otp/verify`, with the same shape and the same guarantees:
 *
 *   - the code is checked by `verifyLoginOtpForChallenge`, which is the exact
 *     function the browser path uses, against the exact same row, under the
 *     same five-attempt / five-minute / single-use limits;
 *   - the caller supplies a code and a challenge token, never a user id. Whose
 *     sign-in this is comes from the challenge, resolved server-side, so there
 *     is nothing in the request for anyone to substitute;
 *   - `issueDeviceTokens` re-reads the account from the database and refuses an
 *     administrator or a disabled user, so eligibility cannot go stale between
 *     the password step and this one.
 *
 * **What it deliberately does not do is call `completeSignIn`.** No browser
 * session is created, and — the part that matters for reporting — no work
 * session is opened. Connecting the Monitor does not put an agent on the clock;
 * only the portal does that.
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

  const payload = body as {
    challengeToken?: unknown;
    code?: unknown;
    device?: { name?: unknown; platform?: unknown; appVersion?: unknown };
  };

  const challengeToken =
    typeof payload.challengeToken === "string" ? payload.challengeToken : "";
  const code = typeof payload.code === "string" ? payload.code : "";

  if (!challengeToken) {
    return Response.json(
      { error: "no_pending", message: "Start again from the sign-in screen." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let result;
  try {
    result = await verifyLoginOtpForChallenge(challengeToken, code);
  } catch (error) {
    console.error("POST /api/monitor/auth/verify: verification failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!result.ok) {
    // Tear the pending state down for the failures that cannot be retried, so
    // the client has something true to fall back to rather than a box that
    // will never accept anything.
    if (result.code === "too_many_attempts" || result.code === "account_disabled") {
      await clearPendingForChallenge(challengeToken).catch(() => {});
    }

    const status =
      result.code === "no_pending" ? 401 : result.code === "account_disabled" ? 403 : 400;

    return Response.json(
      { error: result.code, attemptsRemaining: result.attemptsRemaining },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The code is spent. Kill anything left under this challenge before minting
  // tokens, so a failure in between leaves the client with neither.
  await clearPendingForChallenge(challengeToken).catch(() => {});

  const device = payload.device ?? {};
  let issued;
  try {
    issued = await issueDeviceTokens(result.userId, {
      deviceName: typeof device.name === "string" ? device.name : null,
      platform: typeof device.platform === "string" ? device.platform : null,
      appVersion: typeof device.appVersion === "string" ? device.appVersion : null,
    });
  } catch (error) {
    console.error("POST /api/monitor/auth/verify: could not issue device tokens:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Verified, but the connection could not be saved. Sign in again.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!issued.ok) {
    // Re-checked at the moment of truth: an account disabled or demoted during
    // the five minutes somebody spent reading their email does not connect.
    const status = issued.code === "unknown_user" ? 401 : 403;
    return Response.json(
      { error: issued.code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Opportunistic housekeeping — this app has no cron, and a completed sign-in
  // is a natural, infrequent moment for it. The same pattern the web route uses.
  void pruneExpiredLoginOtps();
  void pruneExpiredDevices();

  return Response.json(
    { ok: true, tokens: issued.tokens, user: issued.user },
    { headers: { "Cache-Control": "no-store" } },
  );
}
