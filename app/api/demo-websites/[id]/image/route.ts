import { apiAdmin, apiModule } from "@/lib/authz";
import { DEMO_IMAGE_TYPES, isDemoImageType, MAX_DEMO_IMAGE_BYTES } from "@/lib/demoImageRules";
import { demoImageSize, demoImageStream } from "@/lib/demoImageStorage";
import {
  demoWebsiteObject,
  isDemoRefusal,
  removeDemoImage,
  saveDemoImage,
} from "@/lib/demoWebsites";

/**
 * The image attached to one demo website.
 *
 *   GET     the bytes — administrators, and agents with the Demo Websites module
 *   POST    upload or replace — ADMIN only
 *   DELETE  remove — ADMIN only
 *
 * ---------------------------------------------------------------------------
 * The read, and why it is a route rather than a file
 * ---------------------------------------------------------------------------
 * This is the **only** way a demo image leaves the server, and it is an
 * authenticated, module-checked request every time. There is no public URL, no
 * signed link and no static directory: the storage root is not under `public/`,
 * nginx has no location for it, and no other code path opens a file under it
 * for reading. The `<img src>` in the list and the detail view points straight
 * here and the browser issues an ordinary same-origin GET carrying the session
 * cookie.
 *
 * An agent without the module cannot reach an image by guessing its URL,
 * because the URL contains a demo website id and not a filename, and because
 * the guard runs before the id is looked at.
 *
 * The order of operations, which is the whole security story:
 *
 *   1. the guard        — session token → session row → user row → role and
 *                         module flags, read from Postgres on this request. 401
 *                         signed out, 403 without the module, before anything
 *                         else runs.
 *   2. the row          — `findUnique` on the id. A `null` is a 404, and it is
 *                         the same 404 for an id that was never real as for one
 *                         that has been deleted: probing ids reveals nothing.
 *   3. the key          — read *off the row*, server-side. The caller does not
 *                         supply it and cannot influence it. There is no
 *                         parameter here that names a file.
 *   4. the root check   — `resolveKey` inside the storage module re-resolves
 *                         the key against the demo image root and refuses
 *                         anything that escapes it, on this read as on every
 *                         other.
 *   5. the bytes        — streamed, never buffered.
 *
 * Points 3 and 4 together are what make `../` traversal and "a file outside
 * DEMO_IMAGES_DIR" unreachable rather than merely defended: the only
 * caller-supplied value is a database primary key, and the only path is one the
 * server generated and re-verified.
 *
 * ---------------------------------------------------------------------------
 * Headers worth their lines
 * ---------------------------------------------------------------------------
 *   Content-Type            from the fixed `DEMO_IMAGE_TYPES` table keyed by
 *                           the sniffed `image_format` column, never the column
 *                           echoed straight out — a header the database can
 *                           dictate is a header an attacker who reaches the
 *                           database can dictate.
 *   Content-Disposition     `inline` with a generated name. The on-disk name is
 *                           not it, and no part of the storage layout appears.
 *   X-Content-Type-Options  belt and braces with the magic-byte sniff done at
 *                           upload: the type sent is derived from the file's
 *                           own header, and this stops a browser having a
 *                           better idea and rendering it as something else.
 *   Cache-Control           `private, no-store`, the same as every other
 *                           authenticated response here. A short browser cache
 *                           was tried and removed: `proxy.ts` stamps
 *                           `no-store, no-cache, must-revalidate` over every
 *                           response it lets through, so a `max-age` on this
 *                           route was a header that never reached anybody and
 *                           a comment that described behaviour the application
 *                           did not have. One rule, written where it is
 *                           enforced.
 */

const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(
  _request: Request,
  context: RouteContext<"/api/demo-websites/[id]/image">,
): Promise<Response> {
  const auth = await apiModule("demoWebsites");
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  const row = await demoWebsiteObject(id);
  if (!row || !row.imageStorageKey || !row.imageFormat) {
    return Response.json(
      { error: "not_found", message: "That demo website has no image." },
      { status: 404, headers: noStore },
    );
  }

  // The format is looked up rather than trusted. A row whose `image_format` is
  // not one this application can serve is a bug or a tampered row, and either
  // way the answer is a refusal instead of a `Content-Type` chosen by the data.
  if (!isDemoImageType(row.imageFormat)) {
    console.error(`Demo website ${id} has an unservable image format: ${row.imageFormat}`);
    return Response.json(
      {
        error: "unsupported_format",
        message: "That image is stored in a format this portal cannot show.",
      },
      { status: 415, headers: noStore },
    );
  }

  const served = DEMO_IMAGE_TYPES[row.imageFormat];

  // The size comes from disk rather than from the row: `Content-Length` has to
  // describe the bytes actually being sent, and a row that disagrees with the
  // file would leave the browser waiting for bytes that are never coming.
  //
  // A missing object is a 410 rather than a 404, matching the screenshot and
  // recording routes: the row is real and the id is right, and "this used to
  // exist" is a different thing to see than "no such image".
  const size = await demoImageSize(row.imageStorageKey);
  if (size === null) {
    console.error(`Demo website ${id} is missing its image object on disk`);
    return Response.json(
      {
        error: "object_missing",
        message: "That image could not be read. Its file is missing from storage.",
      },
      { status: 410, headers: noStore },
    );
  }

  try {
    return new Response(demoImageStream(row.imageStorageKey), {
      status: 200,
      headers: {
        "Content-Type": row.imageFormat,
        "Content-Length": String(size),
        "Content-Disposition": `inline; filename="demo-${row.id}.${served.extension}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    // `resolveKey` throwing lands here, as does a file that disappeared between
    // the `stat` above and this open.
    console.error(`Streaming the image for demo website ${id} failed:`, error);
    return Response.json(
      { error: "server_error", message: "That image could not be read." },
      { status: 500, headers: noStore },
    );
  }
}

/**
 * POST — upload or replace the image. ADMIN only.
 *
 * An agent with the Demo Websites module is refused here even though they may
 * read the very image this writes. That is the module's read-only rule, and it
 * lives in this guard rather than in the panel not drawing an upload control.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/demo-websites/[id]/image">,
): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  // Refuse an oversized body before it is buffered. The header is a claim and
  // the real check is on the bytes, but believing it costs nothing and means a
  // 200MB misdrop is turned away at the first packet rather than after it has
  // all arrived in memory. The slack is for the multipart envelope.
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DEMO_IMAGE_BYTES + 64 * 1024) {
    return Response.json(
      {
        error: "too_large",
        message: `That image is over the ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB limit.`,
      },
      { status: 413, headers: noStore },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "invalid_body", message: 'Expected a multipart form with a "file" field.' },
      { status: 400, headers: noStore },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { error: "missing_file", message: "Choose an image to upload." },
      { status: 400, headers: noStore },
    );
  }

  if (file.size > MAX_DEMO_IMAGE_BYTES) {
    return Response.json(
      {
        error: "too_large",
        message: `That image is over the ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB limit.`,
      },
      { status: 413, headers: noStore },
    );
  }

  try {
    // Only the bytes cross. `file.name` and `file.type` are read by nobody:
    // the stored format is sniffed from the file's own header and the storage
    // key is generated by the server.
    const demoWebsite = await saveDemoImage({
      demoWebsiteId: id,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });

    if (!demoWebsite) {
      return Response.json(
        { error: "not_found", message: "No such demo website." },
        { status: 404, headers: noStore },
      );
    }

    return Response.json({ demoWebsite }, { status: 201, headers: noStore });
  } catch (error) {
    if (isDemoRefusal(error)) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }
    console.error(`POST /api/demo-websites/${id}/image failed:`, error);
    return Response.json(
      { error: "server_error", message: "That image could not be saved." },
      { status: 500, headers: noStore },
    );
  }
}

/** DELETE — remove the image and clear the row's six image columns. ADMIN only. */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/demo-websites/[id]/image">,
): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  const { id } = await context.params;

  try {
    const result = await removeDemoImage(id);
    if (!result) {
      return Response.json(
        { error: "not_found", message: "No such demo website." },
        { status: 404, headers: noStore },
      );
    }

    if (result.imageOrphaned) {
      console.warn(
        `demo-website.image.delete admin=${auth.id} demo=${id} left an orphaned file`,
      );
    }

    return Response.json(
      {
        removed: result.removed,
        imageOrphaned: result.imageOrphaned,
        demoWebsite: result.card,
        ...(result.imageOrphaned
          ? {
              message:
                "The image was removed from the demo website, but its file could not be deleted from storage. Tell an administrator so it can be swept.",
            }
          : {}),
      },
      { headers: noStore },
    );
  } catch (error) {
    console.error(`DELETE /api/demo-websites/${id}/image failed:`, error);
    return Response.json(
      { error: "server_error", message: "That image could not be removed." },
      { status: 500, headers: noStore },
    );
  }
}
