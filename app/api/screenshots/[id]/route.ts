import { apiAdmin } from "@/lib/authz";
import { screenshotCard } from "@/lib/screenshotViewer";

/**
 * GET /api/screenshots/:id — one screenshot's metadata. ADMIN only.
 *
 * Guarded independently of the list it is usually reached from: a route handler
 * cannot inherit another handler's check, and `apiAdmin()` here re-reads the
 * caller's role from Postgres exactly as the list route does. An agent holding
 * a perfectly valid session gets a 403, whichever id they ask for.
 *
 * The gallery already holds every field this returns — the modal opens from a
 * card it was handed, so nothing on the happy path waits for this request. It
 * exists for the cases the grid cannot serve: a link opened directly, and a
 * caller who wants to know whether a row is still there.
 *
 * **The id is a primary key and never a path.** It is used for one
 * `findUnique`, and the response is built from columns that do not include
 * `storageKey`. There is no arrangement of characters that turns it into a file
 * reference, which is what makes "an invalid id cannot reach another file" a
 * property of the shape rather than of a validation somebody has to remember.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/screenshots/[id]">,
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    const screenshot = await screenshotCard(id);
    if (!screenshot) {
      return Response.json(
        { error: "not_found", message: "That screenshot no longer exists." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      { screenshot },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error(`GET /api/screenshots/${id} failed:`, error);
    return Response.json(
      { error: "server_error", message: "Could not load that screenshot." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
