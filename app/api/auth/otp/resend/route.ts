import { resendLoginOtp } from "@/lib/loginOtp";

/**
 * POST /api/auth/otp/resend — send a fresh code for the sign-in in progress.
 *
 * Takes no body at all, and that is the security property worth stating: the
 * caller cannot name an address, a username or a user id, so this endpoint
 * cannot be pointed at a mailbox of the caller's choosing. It sends to the
 * registered address of whoever the pending challenge cookie resolves to, or it
 * does nothing.
 *
 * Abuse is bounded in `lib/loginOtp.ts` by two independent limits — a
 * 30-second cooldown between sends, and a ceiling on the total number of codes
 * per pending sign-in — and neither is enforced by the countdown on the screen.
 * A caller with curl meets exactly the same refusals.
 *
 * A resend invalidates the previous code in the same transaction that writes
 * the new one, so there is never an instant at which two codes work.
 */
export async function POST(): Promise<Response> {
  let result;
  try {
    result = await resendLoginOtp();
  } catch (error) {
    console.error("POST /api/auth/otp/resend: could not issue a new code:", error);
    return Response.json(
      {
        error: "email_failed",
        message: "We could not send a new code. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!result.ok) {
    const status =
      result.code === "no_pending"
        ? 401
        : result.code === "cooldown"
          ? 429
          : result.code === "too_many_sends"
            ? 429
            : 503;

    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (result.retryAfterSeconds) headers["Retry-After"] = String(result.retryAfterSeconds);

    return Response.json(
      { error: result.code, retryAfterSeconds: result.retryAfterSeconds },
      { status, headers },
    );
  }

  return Response.json(
    { ok: true, challenge: result.challenge },
    { headers: { "Cache-Control": "no-store" } },
  );
}
