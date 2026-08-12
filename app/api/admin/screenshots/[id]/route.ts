import { apiAdmin } from "@/lib/authz";
import { deleteScreenshotById, isScreenshotId } from "@/lib/screenshotDeletion";

/**
 * DELETE /api/admin/screenshots/:id — remove one screenshot for good. ADMIN only.
 *
 * The bytes and the row, in that order. There is no soft delete, no bin and no
 * undo: the confirmation dialog in front of this says so, because it is true.
 *
 * ---------------------------------------------------------------------------
 * Why this path and not `/api/screenshots/:id`
 * ---------------------------------------------------------------------------
 * The read side of this feature is `/api/screenshots`, named without an `admin`
 * segment to match `/api/users` and `/api/reports` — this application says who
 * may call an endpoint in `lib/access.ts` and in the handler's own guard, not in
 * the URL. Deletion is deliberately given its own prefix anyway: reading a
 * screenshot and destroying one are different powers, and a `DELETE` verb hung
 * off the viewer's own path is easy to reach by accident from a client that
 * already knows the read URL. `/api/admin` is listed in `ADMIN_PREFIXES`, so the
 * policy is written next to the policy for every other admin path.
 *
 * ---------------------------------------------------------------------------
 * The order of operations
 * ---------------------------------------------------------------------------
 *   1. `apiAdmin()`  — session token → session row → user row → `role`, read
 *                      from Postgres on this request and never from a cookie
 *                      field, a header or a body. 401 signed out, 403 for an
 *                      authenticated agent, before the id is even parsed. An
 *                      agent with a valid session and curl gets the refusal.
 *   2. the shape     — anything that is not a cuid is a 404 without a query.
 *   3. the row       — `findUnique` on the id, inside `lib/screenshotDeletion`.
 *   4. the key       — read *off the row*, server-side. The caller does not
 *                      supply it and cannot influence it; there is no parameter
 *                      here that names a file, so there is nothing for a `../`
 *                      to be part of.
 *   5. the root check— `resolveKey` re-resolves the key against the storage root
 *                      and refuses anything that escapes it, on this delete as
 *                      on every read.
 *
 * ---------------------------------------------------------------------------
 * Honest failure
 * ---------------------------------------------------------------------------
 * A file that will not delete leaves its row in place and answers 500, so the
 * screenshot stays visible in the gallery rather than disappearing from a screen
 * while its bytes remain on disk. "Deleted" here always means both.
 *
 * No audit row is written — this application has no audit table and this feature
 * does not introduce one. The server log line below is the record, and it
 * carries who deleted what, never a path or a storage key.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { id } = await params;

  if (!isScreenshotId(id)) {
    // The same 404 an unknown id gets. A separate 400 for "malformed" would
    // tell a prober which of their guesses were the right shape.
    return Response.json(
      { error: "not_found", message: "No such screenshot." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const problem = await deleteScreenshotById(id);

    if (!problem) {
      console.info(
        `screenshot.delete admin=${auth.id} screenshot=${id} at=${new Date().toISOString()}`,
      );
      return Response.json(
        { ok: true, id },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      { error: problem.reason, message: problem.message, id },
      {
        status: problem.reason === "not_found" ? 404 : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error(`DELETE /api/admin/screenshots/${id} failed:`, error);
    return Response.json(
      { error: "server_error", message: "That screenshot could not be deleted." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
