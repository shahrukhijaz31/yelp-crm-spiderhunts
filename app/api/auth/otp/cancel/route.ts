import { clearPendingChallenge } from "@/lib/loginOtp";

/**
 * POST /api/auth/otp/cancel — abandon the sign-in in progress.
 *
 * What "Back to login" calls. It expires the pending code and clears the
 * cookie, so walking back to the password form genuinely ends the attempt
 * rather than leaving a live code behind that a later visitor to the same
 * browser could be handed.
 *
 * Always 200: abandoning a sign-in is idempotent, and "there was nothing to
 * abandon" is not an error worth showing anyone. Nothing is revealed either
 * way, since the response is the same whether or not a challenge existed.
 */
export async function POST(): Promise<Response> {
  await clearPendingChallenge().catch(() => {});
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
