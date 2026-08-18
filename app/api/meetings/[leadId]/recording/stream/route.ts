import { apiModule } from "@/lib/authz";
import { getRecordingFor } from "@/lib/recordings";
import { recordingSize, recordingStream } from "@/lib/recordingStorage";

/**
 * GET /api/meetings/:leadId/recording/stream — the audio itself.
 *
 * This is the *only* way audio leaves the server, and it is an authenticated
 * request every time. There is no public URL, no signed link, no static
 * directory: the storage root is not under `public/` and nginx has no location
 * for it, so the bytes are unreachable except through this handler, and this
 * handler resolves the caller from the session row in Postgres before it opens
 * the file.
 *
 * The `<audio src>` in the browser points straight here, which is what makes
 * "listen without downloading" work: the element issues ordinary same-origin
 * GETs carrying the session cookie, and gets back exactly the byte ranges it
 * asks for.
 *
 * Range support is not an optimisation here, it is the feature. An audio
 * element cannot show a duration or let anyone scrub through a call unless the
 * server answers `Range:` with a 206 — without it the browser must download the
 * whole file before the first second plays, and dragging the scrubber restarts
 * that download from zero.
 *
 * Headers worth their lines:
 *   Accept-Ranges           advertises the above, or the element will not try.
 *   Content-Disposition     `inline`, so the browser plays rather than saves.
 *   X-Content-Type-Options  belt and braces with the magic-byte sniff in
 *                           `lib/recordings.ts`: the type sent is one of five
 *                           audio types derived from the file's own header, and
 *                           this stops a browser looking for a better idea.
 *   Cache-Control           `private, no-store` — a recording of a client call
 *                           must not sit in a shared cache, and the whole app
 *                           is already `no-store` for the same reason.
 */

export async function GET(
  request: Request,
  context: RouteContext<"/api/meetings/[leadId]/recording/stream">,
): Promise<Response> {
  // The Leads module, like the metadata route beside it: a recording is part of
  // a lead's record, and an account without the worklist has no business with
  // one.
  const auth = await apiModule("leads");
  if (auth instanceof Response) return auth;

  const { leadId } = await context.params;

  // `getRecordingFor` applies the access rule: admins see every recording, an
  // agent sees only their own upload. A recording that exists but is not the
  // caller's comes back null and is answered exactly like one that does not
  // exist — guessing meeting ids reveals nothing.
  const recording = await getRecordingFor(leadId, auth);
  if (!recording) {
    return Response.json(
      { error: "not_found", message: "No recording for that meeting." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // The size is taken from disk rather than from the row: `Content-Length` and
  // `Content-Range` have to describe the bytes actually being sent, and a row
  // that disagrees with the file would hang the player waiting for bytes that
  // are never coming.
  const size = await recordingSize(recording.storageKey);
  if (size === null) {
    console.error(
      `Recording ${recording.id} is missing its object at ${recording.storageKey}`,
    );
    return Response.json(
      {
        error: "object_missing",
        message: "That recording could not be read. Ask an administrator to re-upload it.",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  const headers = new Headers({
    "Content-Type": recording.fileType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(recording.fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });

  const range = parseRange(request.headers.get("range"), size);

  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(recordingStream(recording.storageKey, range), {
      status: 206,
      headers,
    });
  }

  headers.set("Content-Length", String(size));
  return new Response(recordingStream(recording.storageKey), { status: 200, headers });
}

/**
 * Parse a `Range` header into an inclusive byte range.
 *
 * Only single ranges are handled — that is all a media element sends, and a
 * multipart/byteranges response for the general case would be a lot of code
 * for a request that never arrives. Anything unparseable returns null and is
 * answered with the whole file, which is what the spec asks for.
 *
 * Both forms matter in practice: `bytes=500-` (play from here) and `bytes=-64`
 * (the tail, which is where an MP4 keeps the metadata a player needs before it
 * can show a duration).
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (length <= 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return "unsatisfiable";

  return { start, end };
}
