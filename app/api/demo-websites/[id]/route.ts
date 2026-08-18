import { apiAdmin, apiModule } from "@/lib/authz";
import {
  deleteDemoWebsiteRecord,
  getDemoWebsite,
  isDemoRefusal,
  parseDemoWebsiteEdits,
  updateDemoWebsite,
} from "@/lib/demoWebsites";

/**
 * One demo website.
 *
 *   GET     the record, for the detail view
 *   PATCH   edit it
 *   DELETE  remove it, and its image
 *
 * ---------------------------------------------------------------------------
 * The guards, stated per verb
 * ---------------------------------------------------------------------------
 *   GET             `apiModule("demoWebsites")` — administrators and agents
 *                   with the module.
 *   PATCH / DELETE  `apiAdmin()` — administrators only.
 *
 * Written out three times rather than once at the top of the file. A shared
 * guard would have to be the weakest of the three, and the next verb added to
 * this file would silently inherit it.
 *
 * ---------------------------------------------------------------------------
 * `id` is a selector, never a claim
 * ---------------------------------------------------------------------------
 * It comes out of the URL, so it is client-supplied by definition. It is used
 * only to pick a row. It is never compared against the caller, because there
 * is nothing to compare it to: demo websites have no owner column, access to
 * this module is granted per account rather than per record, and an agent who
 * may read one may read all of them by design.
 *
 * That is what makes IDOR a non-question here rather than a check somebody has
 * to remember: changing the id in the URL moves between rows the caller was
 * already entitled to, and an agent who is *not* entitled is refused by the
 * guard before the id is read at all. There is no id anywhere in this module
 * that reaches a different privilege.
 */

const noStore = { "Cache-Control": "no-store" } as const;

function notFound(): Response {
  return Response.json(
    { error: "not_found", message: "No such demo website. It may have been deleted." },
    { status: 404, headers: noStore },
  );
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/demo-websites/[id]">,
): Promise<Response> {
  const auth = await apiModule("demoWebsites");
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    const demoWebsite = await getDemoWebsite(id);
    if (!demoWebsite) return notFound();
    return Response.json({ demoWebsite }, { headers: noStore });
  } catch (error) {
    console.error(`GET /api/demo-websites/${id} failed:`, error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. The demo website could not be opened.",
      },
      { status: 503, headers: noStore },
    );
  }
}

/**
 * PATCH — a partial edit, ADMIN only.
 *
 * Takes only the keys present, so two edits landing close together cannot
 * clobber each other, and `parseDemoWebsiteEdits` is a whitelist of the seven
 * content fields. The six image columns, the id and the timestamps are
 * server-owned and unreachable from this body: `{"imageStorageKey": "..."}`
 * sets nothing, because the key is not a field the parser knows about.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/demo-websites/[id]">,
): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: noStore },
    );
  }

  let edits;
  try {
    edits = parseDemoWebsiteEdits(body);
  } catch (error) {
    if (isDemoRefusal(error)) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }
    throw error;
  }

  if (Object.keys(edits).length === 0) {
    return Response.json(
      { error: "no_changes", message: "Nothing to change." },
      { status: 400, headers: noStore },
    );
  }

  try {
    const demoWebsite = await updateDemoWebsite(id, edits);
    if (!demoWebsite) return notFound();
    return Response.json({ demoWebsite }, { headers: noStore });
  } catch (error) {
    console.error(`PATCH /api/demo-websites/${id} failed:`, error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. The change was not saved.",
      },
      { status: 503, headers: noStore },
    );
  }
}

/**
 * DELETE — remove the record and its image, ADMIN only.
 *
 * The row goes first and the file second; see `deleteDemoWebsiteRecord` for why
 * that order is the safe one. If the file cannot be removed the response still
 * reports success — the record *is* gone, which is what was asked — but it says
 * so honestly with `imageOrphaned: true` and the server logs the key, rather
 * than pretending the disk is clean.
 */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/demo-websites/[id]">,
): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    const result = await deleteDemoWebsiteRecord(id);
    if (!result) return notFound();

    if (result.imageOrphaned) {
      console.warn(`demo-website.delete admin=${auth.id} demo=${id} left an orphaned image`);
    }

    return Response.json(
      {
        deleted: true,
        imageOrphaned: result.imageOrphaned,
        ...(result.imageOrphaned
          ? {
              message:
                "The demo website was deleted, but its image file could not be removed from storage. Tell an administrator so it can be swept.",
            }
          : {}),
      },
      { headers: noStore },
    );
  } catch (error) {
    console.error(`DELETE /api/demo-websites/${id} failed:`, error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. The demo website was not deleted.",
      },
      { status: 503, headers: noStore },
    );
  }
}
