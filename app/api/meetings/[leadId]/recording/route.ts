import { apiUser } from "@/lib/authz";
import {
  MAX_RECORDING_BYTES,
  normaliseDuration,
  RecordingError,
} from "@/lib/recordingRules";
import {
  getRecordingSummaryFor,
  removeRecording,
  saveRecording,
} from "@/lib/recordings";

/**
 * The call recording attached to one meeting.
 *
 *   GET     its metadata
 *   POST    upload, or replace what is there
 *   DELETE  remove it
 *
 * The audio itself is not here — it is streamed by `./stream`, which needs
 * range handling and a different set of headers.
 *
 * Every handler opens with `apiUser()` and then hands the decision to
 * `lib/recordings.ts`. `leadId` comes out of the URL, so it is client-supplied
 * by definition; it is used only to *select* a row, never as a statement about
 * who the caller is. The row it selects is then checked against the session
 * user, and an agent who guesses another agent's meeting id gets the same 404
 * as an agent who guesses a meeting that does not exist.
 *
 * Both roles may POST: uploading the recording of a call is the agent's job,
 * and this is the one place in the API where that is true of a file upload.
 * The CSV import next door is ADMIN-only because it rewrites the shared
 * worklist; this writes one row scoped to one meeting.
 */

/** Map a `RecordingError` onto the error envelope the rest of the API uses. */
function errorResponse(error: unknown, context: string): Response {
  if (error instanceof RecordingError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  console.error(`${context} failed:`, error);
  return Response.json(
    {
      error: "server_error",
      message: "Could not complete that. Try again, and tell an administrator if it persists.",
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(
  _request: Request,
  context: RouteContext<"/api/meetings/[leadId]/recording">,
): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const { leadId } = await context.params;

  try {
    const recording = await getRecordingSummaryFor(leadId, auth);
    if (!recording) {
      return Response.json(
        { error: "not_found", message: "No recording for that meeting." },
        { status: 404, headers: noStore },
      );
    }
    return Response.json({ recording }, { headers: noStore });
  } catch (error) {
    return errorResponse(error, `GET /api/meetings/${leadId}/recording`);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/meetings/[leadId]/recording">,
): Promise<Response> {
  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

  const { leadId } = await context.params;

  // Refuse an oversized body before it is buffered. The header is a claim and
  // the real check is on the bytes, but believing it costs nothing and means a
  // 200MB misdrop is turned away at the first packet rather than after it has
  // all arrived in memory.
  // The slack is for the multipart envelope — boundaries and part headers, a
  // few hundred bytes — so a file exactly at the limit is not refused by its
  // own wrapper.
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RECORDING_BYTES + 64 * 1024) {
    return Response.json(
      {
        error: "too_large",
        message: `That recording is over the ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)}MB limit.`,
      },
      { status: 413, headers: noStore },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "invalid_body", message: "Expected a multipart form with a \"file\" field." },
      { status: 400, headers: noStore },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { error: "missing_file", message: "Choose an audio file to upload." },
      { status: 400, headers: noStore },
    );
  }

  if (file.size > MAX_RECORDING_BYTES) {
    return Response.json(
      {
        error: "too_large",
        message: `That recording is over the ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)}MB limit.`,
      },
      { status: 413, headers: noStore },
    );
  }

  try {
    const recording = await saveRecording({
      leadId,
      user: auth,
      fileName: file.name,
      declaredType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      // Read from the audio element in the browser, so it is display metadata
      // and treated as such: clamped, optional, and never load-bearing.
      durationSeconds: normaliseDuration(form.get("durationSeconds")),
    });

    return Response.json({ recording }, { status: 201, headers: noStore });
  } catch (error) {
    return errorResponse(error, `POST /api/meetings/${leadId}/recording`);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/meetings/[leadId]/recording">,
): Promise<Response> {
  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

  const { leadId } = await context.params;

  try {
    const removed = await removeRecording(leadId, auth);
    if (!removed) {
      return Response.json(
        { error: "not_found", message: "No recording for that meeting." },
        { status: 404, headers: noStore },
      );
    }
    return Response.json({ deleted: true }, { headers: noStore });
  } catch (error) {
    return errorResponse(error, `DELETE /api/meetings/${leadId}/recording`);
  }
}
