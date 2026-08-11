import { resendLoginOtpForChallenge } from "@/lib/loginOtp";

/**
 * POST /api/monitor/auth/resend — send a fresh code for the sign-in in
 * progress.
 *
 * A three-line wrapper over the same `resendLoginOtpForChallenge` the browser's
 * Resend button reaches, so the cooldown, the per-sign-in send cap and the rule
 * that the new code kills the old one are enforced once, in `lib/loginOtp.ts`,
 * for both clients. The challenge token is not rotated — this is the same
 * pending sign-in — so the desktop client keeps the token it already holds.
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

  const challengeToken =
    typeof (body as { challengeToken?: unknown }).challengeToken === "string"
      ? ((body as { challengeToken: string }).challengeToken)
      : "";

  if (!challengeToken) {
    return Response.json(
      { error: "no_pending", message: "Start again from the sign-in screen." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let result;
  try {
    result = await resendLoginOtpForChallenge(challengeToken);
  } catch (error) {
    console.error("POST /api/monitor/auth/resend: resend failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!result.ok) {
    const status =
      result.code === "no_pending" ? 401 : result.code === "cooldown" ? 429 : 400;

    return Response.json(
      { error: result.code, retryAfterSeconds: result.retryAfterSeconds },
      {
        status,
        headers: {
          "Cache-Control": "no-store",
          ...(result.retryAfterSeconds
            ? { "Retry-After": String(result.retryAfterSeconds) }
            : {}),
        },
      },
    );
  }

  return Response.json(
    { ok: true, challenge: result.challenge },
    { headers: { "Cache-Control": "no-store" } },
  );
}
