import { apiAdmin } from "@/lib/authz";
import { destroyAllSessionsFor } from "@/lib/session";
import { editEndsAccess, updateUser, UserInputError, type UserEdits } from "@/lib/userDb";

/**
 * PATCH /api/users/:id — change a role, disable an account, rename, reset a
 * password. ADMIN only.
 *
 * Two guards that are not about the caller's role:
 *
 *   Self-edits of `role` and `isActive` are refused. An administrator
 *   demoting or disabling themselves mid-session is a self-inflicted lockout,
 *   and it is never what was meant. (`lib/userDb` separately refuses to remove
 *   the *last* administrator, whoever asks.)
 *
 *   Any change that alters what the target may do ends their sessions. Roles
 *   are resolved per request from the database, so a demoted admin would lose
 *   their extra access on the very next request anyway — but signing them out
 *   makes it unambiguous rather than leaving them on a page that is about to
 *   start refusing them.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const payload = body as Record<string, unknown>;
  const edits: UserEdits = {};
  if (payload.role !== undefined) edits.role = payload.role as UserEdits["role"];
  if (payload.isActive !== undefined) edits.isActive = payload.isActive as boolean;
  if (payload.name !== undefined) edits.name = String(payload.name);
  if (payload.password !== undefined) edits.password = String(payload.password);

  if (Object.keys(edits).length === 0) {
    return Response.json(
      { error: "no_changes", message: "Nothing to change." },
      { status: 400 },
    );
  }

  if (id === auth.id && (edits.role !== undefined || edits.isActive !== undefined)) {
    return Response.json(
      {
        error: "self_edit_refused",
        message: "You cannot change your own role or disable your own account.",
      },
      { status: 400 },
    );
  }

  try {
    const user = await updateUser(id, edits);
    if (!user) {
      return Response.json(
        { error: "not_found", message: "No such user." },
        { status: 404 },
      );
    }

    if (editEndsAccess(edits)) await destroyAllSessionsFor(id);

    return Response.json({ user }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserInputError) {
      return Response.json({ error: "invalid_input", message: error.message }, { status: 400 });
    }
    console.error(`PATCH /api/users/${id} failed:`, error);
    return Response.json(
      { error: "database_unavailable", message: "Could not save the change." },
      { status: 503 },
    );
  }
}
