import { apiAdmin } from "@/lib/authz";
import { issueResetCode, RESET_CODE_TTL_MINUTES } from "@/lib/passwordReset";
import { findUserForReset } from "@/lib/userDb";

/**
 * POST /api/users/:id/password-reset — issue a one-time reset code. ADMIN only.
 *
 * The *only* administrative route to somebody else's credentials, and note
 * what it is not: there is no GET here, no endpoint anywhere that reads a
 * password or a hash, and nothing in this response derived from the account's
 * existing password. An administrator can end a password and hand over a way
 * to set a new one. They cannot learn the old one, because no code exists that
 * would tell them.
 *
 * The generated code crosses the wire exactly once, in this response, and is
 * never persisted in a form anyone can read back — see `lib/passwordReset.ts`.
 * That is what the dialog's "this will only be shown once" is describing: not a
 * UI convention, a fact about the database.
 *
 * `/api/users` is already an ADMIN prefix at the proxy and `apiAdmin()` checks
 * the session against Postgres regardless, so an agent posting here is refused
 * twice over before any user is looked up.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { id } = await params;

  // Resetting your own account here would scramble the password of the person
  // pressing the button and sign them out mid-action — with the reset code
  // sitting on a screen they are about to be redirected away from. An
  // administrator changing their own password has the profile menu for it,
  // which is the safe operation because it needs the current password.
  if (id === auth.id) {
    return Response.json(
      {
        error: "self_reset_refused",
        message:
          "Use Change password in your profile menu to change your own password.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const target = await findUserForReset(id);
    if (!target) {
      return Response.json(
        { error: "not_found", message: "No such user." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    const { code, expiresAt } = await issueResetCode(target.id, auth.id);

    // The actors and the outcome, never the credential. A reset code in a log
    // file is a reset code an operator can use.
    console.info(`password reset code issued for user ${target.id} by admin ${auth.id}`);

    return Response.json(
      {
        code,
        expiresAt: expiresAt.toISOString(),
        expiresInMinutes: RESET_CODE_TTL_MINUTES,
        user: { id: target.id, name: target.name, username: target.username },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(`POST /api/users/${id}/password-reset failed:`, error);
    return Response.json(
      { error: "database_unavailable", message: "Could not generate a reset code." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
