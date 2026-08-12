import { apiAdmin } from "@/lib/authz";
import { screenshotObject } from "@/lib/screenshotViewer";
import { screenshotSize, screenshotStream } from "@/lib/screenshotStorage";

/**
 * GET /api/screenshots/:id/image — the image itself. ADMIN only.
 *
 * This is the **only** way a screenshot leaves the server, and it is an
 * authenticated, role-checked request every time. There is no public URL, no
 * signed link and no static directory: the storage root is not under `public/`,
 * nginx has no location for it, and no other code path opens a file under it
 * for reading. The `<img src>` in the gallery points straight here and the
 * browser issues an ordinary same-origin GET carrying the session cookie.
 *
 * ---------------------------------------------------------------------------
 * The order of operations, which is the whole security story
 * ---------------------------------------------------------------------------
 *
 *   1. `apiAdmin()`      — session token → session row → user row → `role`.
 *                          Read from Postgres on this request, not from the
 *                          cookie, a header or a body. 401 signed out, 403 for
 *                          an authenticated agent, before anything else runs.
 *   2. the row           — `findUnique` on the id. A `null` is a 404, and it is
 *                          the same 404 whether the id was never real or has
 *                          been swept by retention: probing ids reveals nothing.
 *   3. the key           — read *off the row*, server-side. The caller does not
 *                          supply it and cannot influence it. There is no
 *                          parameter here that names a file.
 *   4. the root check    — `resolveKey` inside the storage module re-resolves
 *                          the key against the storage root and refuses
 *                          anything that escapes it, on this read as on every
 *                          other. Belt and braces behind a key the application
 *                          minted itself.
 *   5. the bytes         — streamed, never buffered.
 *
 * Points 3 and 4 together are what make "`../` traversal" and "a file outside
 * `SCREENSHOTS_DIR`" unreachable rather than merely defended: the only
 * caller-supplied value is a database primary key, and the only path is one the
 * server generated and re-verified.
 *
 * ---------------------------------------------------------------------------
 * Headers worth their lines
 * ---------------------------------------------------------------------------
 *   Content-Type            from a fixed map keyed by the sniffed `format`
 *                           column, never the column echoed straight out — a
 *                           header the database can dictate is a header an
 *                           attacker who reaches the database can dictate.
 *   Content-Disposition     `inline` with a generated name. The on-disk name is
 *                           not it, and no part of the storage layout appears.
 *   X-Content-Type-Options  belt and braces with the magic-byte sniff done at
 *                           upload: the type sent is derived from the file's
 *                           own header, and this stops a browser having a
 *                           better idea and rendering it as something else.
 *   Cache-Control           `private, no-store`. An image of somebody's desktop
 *                           must not sit in a shared cache, and must not be
 *                           left in a disk cache after the administrator has
 *                           signed out.
 */

/** The types this route will serve, and the extension each gets. */
const SERVED_TYPES: Record<string, { contentType: string; extension: string }> = {
  "image/jpeg": { contentType: "image/jpeg", extension: "jpg" },
};

export async function GET(
  _request: Request,
  context: RouteContext<"/api/screenshots/[id]/image">,
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  const screenshot = await screenshotObject(id);
  if (!screenshot) {
    return Response.json(
      { error: "not_found", message: "That screenshot no longer exists." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  /*
   * The audit trail.
   *
   * This application has no audit table, and this stage is not the place to
   * introduce one — so the record is a server log line, which the deployment
   * already collects through systemd. It carries the four things an
   * investigation needs and nothing else: who looked, at which screenshot,
   * whose desktop it was, and when.
   *
   * Never the image, never the storage key. A log line that quoted the path
   * would put the storage layout in a file with far wider read access than the
   * storage root itself.
   */
  console.info(
    `screenshot.view admin=${auth.id} screenshot=${screenshot.id} subject=${screenshot.userId} at=${new Date().toISOString()}`,
  );

  const served = SERVED_TYPES[screenshot.format];
  if (!served) {
    console.error(
      `Screenshot ${screenshot.id} has an unservable format: ${screenshot.format}`,
    );
    return Response.json(
      {
        error: "unsupported_format",
        message: "That screenshot is stored in a format this viewer cannot show.",
      },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The size comes from disk rather than from the row: `Content-Length` has to
  // describe the bytes actually being sent, and a row that disagrees with the
  // file would leave the browser waiting for bytes that are never coming.
  //
  // A missing object is a 410 rather than a 404, matching the recording stream:
  // the row is real and the id is right, and "this used to exist" is a
  // different thing for an administrator to see than "no such screenshot".
  const size = await screenshotSize(screenshot.storageKey);
  if (size === null) {
    console.error(`Screenshot ${screenshot.id} is missing its object on disk`);
    return Response.json(
      {
        error: "object_missing",
        message: "That screenshot could not be read. Its image file is missing.",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    return new Response(screenshotStream(screenshot.storageKey), {
      status: 200,
      headers: {
        "Content-Type": served.contentType,
        "Content-Length": String(size),
        "Content-Disposition": `inline; filename="screenshot-${screenshot.id}.${served.extension}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    // `resolveKey` throwing lands here, as does a file that disappeared between
    // the `stat` above and this open.
    console.error(`Streaming screenshot ${screenshot.id} failed:`, error);
    return Response.json(
      { error: "server_error", message: "That screenshot could not be read." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
