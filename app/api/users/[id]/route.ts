import { apiAdmin } from "@/lib/authz";
import { destroyAllSessionsFor } from "@/lib/session";
import {
  deleteUser,
  editEndsAccess,
  updateUser,
  UserDeleteBlocked,
  UserInputError,
  type UserEdits,
} from "@/lib/userDb";

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
  const auth = await apiAdmin(request);
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

/**
 * DELETE /api/users/:id — remove an account outright. ADMIN only.
 *
 * The destructive sibling of `PATCH { isActive: false }`, and deliberately the
 * lesser-used one. Disabling is what this portal does with people who leave: it
 * ends access on the next request and keeps the record of what they did. Delete
 * is for accounts that should never have existed — the typo, the duplicate, the
 * person who was set up and never signed in.
 *
 * Three refusals, each returning a different status so the client can say
 * something useful rather than "that failed":
 *
 *   400  deleting yourself. Same reasoning as the self-edit guard above: an
 *        administrator removing their own account mid-session is a lockout, and
 *        it is never what was meant. Unlike role and disable, there is no
 *        recovery path at all for this one.
 *   400  the last active administrator, refused inside `deleteUser` so a second
 *        caller cannot slip past a check done here.
 *   409  the account has history — logged calls, uploaded recordings, or resets
 *        it issued for other people. Not an error in the request; the request
 *        was fine and the answer is "no, and here is what is in the way". The
 *        message names the counts and points at Disable.
 *
 * 409 rather than 403: the caller is permitted to make this request, and the
 * conflict is with the state of the data, not with who they are. A 403 would
 * read as "you are not allowed", which would send an administrator looking for
 * a permission that does not exist.
 *
 * There is no `?force=` and no cascade override. The foreign keys that block
 * this (`onDelete: Restrict` on lead activity, recordings and issued resets)
 * are what make every per-agent figure in the reports attributable; an escape
 * hatch here would let one click silently rewrite a month of somebody's
 * reported work.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  const { id } = await params;

  if (id === auth.id) {
    return Response.json(
      {
        error: "self_delete_refused",
        message:
          "You cannot delete your own account. Ask another administrator to do it.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const removed = await deleteUser(id);
    if (!removed) {
      return Response.json(
        { error: "not_found", message: "No such user. It may already have been deleted." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Belt and braces. The `sessions` rows cascade with the user, so this finds
    // nothing — but "the account is gone" and "its sessions are gone" should not
    // depend on a foreign-key rule staying as it is today.
    await destroyAllSessionsFor(id).catch(() => {});

    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserDeleteBlocked) {
      return Response.json(
        { error: "has_history", message: error.message, footprint: error.footprint },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof UserInputError) {
      return Response.json(
        { error: "invalid_input", message: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error(`DELETE /api/users/${id} failed:`, error);
    return Response.json(
      { error: "database_unavailable", message: "Could not delete the account." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
