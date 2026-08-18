import { clientIp } from "@/lib/loginThrottle";
import { isMailConfigured } from "@/lib/mail";
import { requestResetCode } from "@/lib/passwordReset";
import {
  consumeRateLimit,
  PASSWORD_RESET_REQUEST_IP_LIMIT,
  PASSWORD_RESET_REQUEST_LIMIT,
  tooManyRequestsJson,
} from "@/lib/rateLimit";

/**
 * POST /api/auth/reset/request — email a one-time reset code to the account.
 *
 * The self-service half of recovery, for the agent who cannot sign in and has
 * nobody to ask. Public of necessity: someone locked out has no session by
 * definition.
 *
 * **The success response is a constant.** No such username, an account that is
 * disabled, a code already sent a moment ago and a code sent right now all
 * return the identical body, because anything else would make this endpoint a
 * way for an anonymous caller to ask which usernames exist and which mailboxes
 * are live. The browser is told what is true either way: *if* that account
 * exists, a code is on its way to the address on it.
 *
 * **Nothing about the account changes here.** The password is untouched, no
 * session is ended and no flag is raised — see `lib/passwordReset.ts`. That is
 * what keeps this from being a denial-of-service button: knowing somebody's
 * username buys you the ability to send them an email they can ignore, and
 * nothing else.
 *
 * **The one honest failure is SMTP.** If mail is unconfigured or the server
 * refuses the message, this says so rather than returning the cheerful
 * constant, because a silent failure here is a person waiting for an email that
 * will never come, in a workspace where nobody has noticed the mailer is down.
 * That does leak "this account exists" to a caller who can also observe an SMTP
 * outage, and that trade is made deliberately in favour of not stranding
 * people.
 *
 * Two brakes, both in Postgres (`lib/rateLimit.ts`): one per account, so no
 * single mailbox can be flooded, and one per source address, so one machine
 * cannot walk a username list. The per-minute cooldown that stops a
 * double-clicked button from invalidating a code already in flight is in
 * `lib/passwordReset.ts`, next to the write it protects.
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

  if (!username) {
    return Response.json(
      { error: "missing_fields", message: "Enter your username or email address." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Checked before anything is looked up, so a deployment missing its SMTP
  // variables fails the same way for every caller and leaks nothing.
  if (!isMailConfigured()) {
    console.error("POST /api/auth/reset/request: SMTP is not configured.");
    return Response.json(
      {
        error: "email_unavailable",
        message:
          "Reset codes cannot be emailed right now. Contact your workspace administrator.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = clientIp(request);
  const byAccount = await consumeRateLimit(PASSWORD_RESET_REQUEST_LIMIT, username.toLowerCase());
  if (!byAccount.allowed) return tooManyRequestsJson(byAccount);

  const byIp = await consumeRateLimit(PASSWORD_RESET_REQUEST_IP_LIMIT, ip);
  if (!byIp.allowed) return tooManyRequestsJson(byIp);

  try {
    const outcome = await requestResetCode(username);

    if (!outcome.sent && outcome.reason === "email_failed") {
      return Response.json(
        {
          error: "email_failed",
          message: "We could not send your reset code. Try again in a moment.",
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Deliberately one line for every other outcome. It records that a request
    // happened, not whose — the username typed by an anonymous caller has no
    // business in a log file, and printing it would put a real person's
    // identifier there on the say-so of whoever typed it.
    console.info(`password reset code requested (sent=${outcome.sent})`);

    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("POST /api/auth/reset/request failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not send a reset code." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
