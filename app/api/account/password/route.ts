import { apiUser } from "@/lib/authz";
import {
  checkLoginAllowed,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/loginThrottle";
import { destroyOtherSessionsFor } from "@/lib/session";
import { changeOwnPassword, UserInputError } from "@/lib/userDb";

/**
 * POST /api/account/password — change your own password.
 *
 * Open to every signed-in user, agent and administrator alike, and open to
 * *only* your own account: the id comes from the session, never from the body,
 * so there is no parameter to tamper with and no version of this endpoint that
 * touches somebody else. That is why it needs no role check.
 *
 * Verifying the current password is the whole security of it, and it is done
 * here rather than trusted from the form. A session proves a browser signed in
 * once; it does not prove who is at the keyboard now.
 *
 * The attempt is throttled on the account id, sharing the brake the login
 * route uses, because an unattended logged-in machine is otherwise an
 * unlimited oracle for guessing the owner's password.
 *
 * Nothing about the password — old or new, plaintext or hash — is returned,
 * logged, or echoed back in an error. The messages name the *problem*
 * ("your current password is not correct"), never the value.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

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
  const currentPassword =
    typeof payload.currentPassword === "string" ? payload.currentPassword : "";
  const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
  const confirmPassword =
    typeof payload.confirmPassword === "string" ? payload.confirmPassword : "";

  if (!currentPassword || !newPassword) {
    return Response.json(
      { error: "missing_fields", message: "Fill in every field." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Checked server-side as well as in the form. The confirmation field is a
  // typo guard, and a typo guard that only exists in the browser guards
  // nothing for a client that does not run it.
  if (newPassword !== confirmPassword) {
    return Response.json(
      { error: "mismatch", message: "The new passwords do not match." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ip = clientIp(request);
  // Keyed on the account id and namespaced, so a slow-guessing attacker cannot
  // use this endpoint to lock the owner out of the *login* form as a side
  // effect — a denial of service dressed up as a brake.
  const throttleKey = `pwchange:${auth.id}`;
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
    await changeOwnPassword(auth.id, currentPassword, newPassword);
  } catch (error) {
    if (error instanceof UserInputError) {
      recordLoginFailure(throttleKey, ip);
      return Response.json(
        { error: "invalid_input", message: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("POST /api/account/password failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not save the change." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  clearLoginFailures(throttleKey);

  // This browser keeps its session — being signed out of the tab you just used
  // to prove you know the password is a punishment for good behaviour. Every
  // *other* session ends, because "someone else may know it" is the usual
  // reason for changing a password at all.
  await destroyOtherSessionsFor(auth.id).catch((error) => {
    console.error("POST /api/account/password: could not end other sessions:", error);
  });

  // Audit trail, such as it is: this app has no activity log, so the event goes
  // where the app's other operational events go. The id identifies the actor
  // and nothing else — no password, no hash, no code.
  console.info(`password changed by user ${auth.id}`);

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
