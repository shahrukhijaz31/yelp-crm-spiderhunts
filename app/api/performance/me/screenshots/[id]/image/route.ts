import { apiUser } from "@/lib/authz";
import { myScreenshotObject } from "@/lib/myScreenshots";
import { screenshotSize, screenshotStream } from "@/lib/screenshotStorage";

/**
 * GET /api/performance/me/screenshots/:id/image — one of the caller's own
 * screenshots, as bytes.
 *
 * The agent-side twin of `/api/screenshots/:id/image`, and deliberately not a
 * relaxation of it. That route still answers 403 to an agent for any id at all;
 * this one answers only for rows that belong to the caller. Neither delegates
 * to the other and neither can be reached by editing a URL into the other's
 * shape.
 *
 * ---------------------------------------------------------------------------
 * It authorizes itself
 * ---------------------------------------------------------------------------
 * The `<img src>` in the gallery points straight here, and this handler assumes
 * nothing about the request that produced that URL. The list endpoint having
 * returned an id is not a permission and is not consulted: every request
 * repeats the whole check — session row → user id → a `findFirst` that carries
 * that user id in its `where`. Pasting the URL into another agent's browser, or
 * into a signed-out one, meets the same two steps and fails at one of them.
 *
 * ---------------------------------------------------------------------------
 * Why another agent's id is a 404 and not a 403
 * ---------------------------------------------------------------------------
 * Because the question "does this screenshot exist" is itself something an
 * agent should not be able to answer about a colleague. `myScreenshotObject`
 * returns `null` for a row that belongs to somebody else and `null` for a row
 * that never existed, so there is one branch below and one response body, and
 * the two cases cannot drift apart later. Retention having swept a row lands in
 * the same place. Probing ids yields nothing but 404s at whatever rate the
 * prober likes.
 *
 * ---------------------------------------------------------------------------
 * The path
 * ---------------------------------------------------------------------------
 * Unchanged from the admin route, because it was already right: the caller
 * supplies a database primary key and nothing else, the storage key is read off
 * the row server-side, and `resolveKey` inside the storage module re-resolves it
 * against the storage root and refuses anything that escapes. No storage key
 * appears in this response, in its headers, or in the list payload that sent
 * the browser here. There is no static directory, no public URL and no signed
 * link — the storage root is not under `public/` and nothing else opens a file
 * beneath it for reading.
 */

/** The types this route will serve, and the extension each gets. */
const SERVED_TYPES: Record<string, { contentType: string; extension: string }> = {
  "image/jpeg": { contentType: "image/jpeg", extension: "jpg" },
};

export async function GET(
  _request: Request,
  context: RouteContext<"/api/performance/me/screenshots/[id]/image">,
): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  const screenshot = await myScreenshotObject(auth.id, id);
  if (!screenshot) {
    return Response.json(
      { error: "not_found", message: "That screenshot no longer exists." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

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

  // From disk rather than from the row, as the admin route does it: a
  // `Content-Length` that disagrees with the body leaves the browser waiting
  // for bytes that are never coming. A real row whose object has gone is a 410,
  // which is a different thing to say than "no such screenshot" — and it is
  // only ever said about a row this caller already owns, so it discloses
  // nothing the 404 above was protecting.
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
        // A generated name. The on-disk name is not it, and no part of the
        // storage layout appears.
        "Content-Disposition": `inline; filename="screenshot-${screenshot.id}.${served.extension}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error(`Streaming screenshot ${screenshot.id} failed:`, error);
    return Response.json(
      { error: "server_error", message: "That screenshot could not be read." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
