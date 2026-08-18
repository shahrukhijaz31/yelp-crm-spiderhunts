import { apiModule } from "@/lib/authz";
import { DemoImageError, DEMO_IMAGE_TYPES, isDemoImageType, MAX_DEMO_IMAGE_BYTES } from "@/lib/demoImageRules";
import { demoImageSize, demoImageStream } from "@/lib/demoImageStorage";
import { demoImageObject, removeDemoImageFor, saveDemoImageFor } from "@/lib/demoWebsites";

/**
 * The demo image on one lead.
 *
 *   GET     the bytes
 *   POST    upload or replace
 *   DELETE  remove
 *
 * All three behind the Demo Websites module, which is the whole permission
 * story: an agent granted it may see and set the demo image on any lead in the
 * pool, and an agent without it may do neither on any lead. There is no
 * per-lead ownership in this application to check against, so there is nothing
 * a changed id in the URL can reach that the module did not already grant.
 *
 * ---------------------------------------------------------------------------
 * The read, and why it is a route rather than a file
 * ---------------------------------------------------------------------------
 * This is the **only** way a demo image leaves the server, and it is an
 * authenticated, module-checked request every time. There is no public URL, no
 * signed link and no static directory: the storage root is not under `public/`,
 * nginx has no location for it, and no other code path opens a file under it
 * for reading. The `<img src>` in the table and the workspace points straight
 * here and the browser issues an ordinary same-origin GET carrying the session
 * cookie.
 *
 * An agent without the module cannot reach an image by guessing a URL, because
 * the URL names a *lead* and not a file, and because the guard runs before the
 * id is looked at. An agent *with* the module changing the id gets a different
 * lead's image — which is correct, and is the same thing they get by scrolling
 * the list.
 *
 * The order of operations, which is the whole security story:
 *
 *   1. the guard      — session token → session row → user row → role and
 *                       module flags, read from Postgres on this request. 401
 *                       signed out, 403 without the module, before anything
 *                       else runs.
 *   2. the row        — `findUnique` on the lead id. Absent is a 404, and it is
 *                       the same 404 for a lead that never existed as for one
 *                       with no image: probing ids reveals nothing.
 *   3. the key        — read *off the row*, server-side. The caller does not
 *                       supply it and cannot influence it. There is no
 *                       parameter here that names a file.
 *   4. the root check — `resolveKey` inside the storage module re-resolves the
 *                       key against the demo image root and refuses anything
 *                       that escapes it, on this read as on every other.
 *   5. the bytes      — streamed, never buffered.
 *
 * Points 3 and 4 together are what make `../` traversal and "a file outside
 * DEMO_IMAGES_DIR" unreachable rather than merely defended: the only
 * caller-supplied value is a lead's primary key, and the only path is one the
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
 *   Cache-Control           `private, no-store`, like every other authenticated
 *                           response here — and what `proxy.ts` stamps over
 *                           everything it lets through in any case.
 */

const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiModule("demoWebsites");
  if (auth instanceof Response) return auth;

  const { id } = await params;

  const row = await demoImageObject(id);
  if (!row || !row.imageStorageKey || !row.imageFormat) {
    return Response.json(
      { error: "not_found", message: "That lead has no demo image." },
      { status: 404, headers: noStore },
    );
  }

  // The format is looked up rather than trusted. A row whose `image_format` is
  // not one this application can serve is a bug or a tampered row, and either
  // way the answer is a refusal instead of a `Content-Type` chosen by the data.
  if (!isDemoImageType(row.imageFormat)) {
    console.error(`Lead ${id} has an unservable demo image format: ${row.imageFormat}`);
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
    console.error(`Lead ${id} is missing its demo image object on disk`);
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
        "Content-Disposition": `inline; filename="demo-${row.leadId}.${served.extension}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    // `resolveKey` throwing lands here, as does a file that disappeared between
    // the `stat` above and this open.
    console.error(`Streaming the demo image for lead ${id} failed:`, error);
    return Response.json(
      { error: "server_error", message: "That image could not be read." },
      { status: 500, headers: noStore },
    );
  }
}

/**
 * POST — upload or replace the demo image.
 *
 * Open to anyone with the Demo Websites module, agents included: attaching the
 * image of a demo is the job the module exists for, in the same way uploading a
 * call recording is the job an agent does on the worklist.
 *
 * Only the bytes cross. `file.name` and `file.type` are read by nobody: the
 * stored format is sniffed from the file's own header, and the storage key is
 * generated by the server.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiModule("demoWebsites", request);
  if (auth instanceof Response) return auth;

  const { id } = await params;

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
    const demo = await saveDemoImageFor({
      leadId: id,
      bytes: new Uint8Array(await file.arrayBuffer()),
      actorId: auth.id,
    });

    if (!demo) {
      return Response.json(
        { error: "not_found", message: "No such lead." },
        { status: 404, headers: noStore },
      );
    }

    return Response.json({ demo }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof DemoImageError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }
    console.error(`POST /api/leads/${id}/demo/image failed:`, error);
    return Response.json(
      { error: "server_error", message: "That image could not be saved." },
      { status: 500, headers: noStore },
    );
  }
}

/** DELETE — remove the demo image and clear the row's image columns. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiModule("demoWebsites", request);
  if (auth instanceof Response) return auth;

  const { id } = await params;

  try {
    const result = await removeDemoImageFor(id, auth.id);
    if (!result) {
      // The lead itself is gone or was never real. Checked rather than inferred
      // from `removeDemoImageFor` returning nothing to do, so "no such lead" and
      // "no image on this lead" stay different answers.
      return Response.json(
        { error: "not_found", message: "No such lead." },
        { status: 404, headers: noStore },
      );
    }

    if (result.imageOrphaned) {
      console.warn(`demo.image.delete user=${auth.id} lead=${id} left an orphaned file`);
    }

    return Response.json(
      {
        removed: result.removed,
        imageOrphaned: result.imageOrphaned,
        demo: result.summary,
        ...(result.imageOrphaned
          ? {
              message:
                "The image was removed from the lead, but its file could not be deleted from storage. Tell an administrator so it can be swept.",
            }
          : {}),
      },
      { headers: noStore },
    );
  } catch (error) {
    console.error(`DELETE /api/leads/${id}/demo/image failed:`, error);
    return Response.json(
      { error: "server_error", message: "That image could not be removed." },
      { status: 500, headers: noStore },
    );
  }
}
