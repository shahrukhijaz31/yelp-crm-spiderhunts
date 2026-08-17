import { apiAdmin } from "@/lib/authz";
import { rateLimitRefusal, SCREENSHOT_BULK_DELETE_LIMIT } from "@/lib/rateLimit";
import {
  deleteScreenshots,
  isScreenshotId,
  MAX_BULK_DELETE,
} from "@/lib/screenshotDeletion";

/**
 * DELETE /api/admin/screenshots — remove several screenshots at once. ADMIN only.
 *
 * Body: `{ "ids": ["…", "…"] }`, and nothing else is read. There is no filter
 * form of this endpoint — no `?agent=`, no `?day=`, no "delete everything that
 * matches what I am looking at". A delete-by-filter is one mistyped date away
 * from destroying a month of evidence, and the id list is what makes the request
 * describe exactly the screenshots the administrator was shown and ticked.
 *
 * ---------------------------------------------------------------------------
 * What the client may name
 * ---------------------------------------------------------------------------
 * Database primary keys. That is the whole vocabulary. The body is not a path,
 * not a storage key and not a glob; ids that are not the shape of a cuid are
 * reported as failures rather than queried, and every storage key is read off
 * the row the server looked up (`lib/screenshotDeletion.ts`). There is no
 * arrangement of characters in this body that can name a file, which is what
 * makes traversal unreachable here rather than merely defended.
 *
 * ---------------------------------------------------------------------------
 * 200 with a report, not 207 and not all-or-nothing
 * ---------------------------------------------------------------------------
 * The request either was or was not accepted; the outcome per screenshot is
 * data, and it comes back as data:
 *
 *   { deleted: ["…"], failed: [{ id, reason, message }], requested: n }
 *
 * One screenshot whose file is locked must not keep the other ninety-nine, and
 * it must not be silently counted as deleted either — its row stays, its id
 * comes back in `failed`, and the gallery keeps showing it. The UI renders the
 * final state from this payload rather than from an assumption.
 *
 * A body with no usable ids at all is a 400: that is a malformed request, not a
 * bulk delete of nothing.
 *
 * Guarded by `apiAdmin()` on the first line, which resolves the caller from the
 * session row in Postgres and answers 401 signed out / 403 to an agent before
 * the body is read. See the sibling `[id]` route for the rest of the reasoning,
 * which is identical.
 */
export async function DELETE(request: Request): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  /*
   * One call can destroy 500 rows and 500 files, and that ceiling is unchanged
   * below. What this adds is a ceiling on how many such calls arrive: 20 in
   * five minutes still clears ten thousand screenshots, so a genuine purge is
   * not obstructed, while a loop pointed at this endpoint is.
   */
  const limited = await rateLimitRefusal(SCREENSHOT_BULK_DELETE_LIMIT, auth.id);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const raw = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(raw)) {
    return Response.json(
      { error: "invalid_input", message: "Send a list of screenshot ids as `ids`." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (raw.length === 0) {
    return Response.json(
      { error: "invalid_input", message: "No screenshots were selected." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (raw.length > MAX_BULK_DELETE) {
    return Response.json(
      {
        error: "too_many",
        message: `Delete at most ${MAX_BULK_DELETE} screenshots at a time.`,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Anything that is not a string is dropped here rather than carried into the
  // deletion module as an `unknown`: a body is an arbitrary JSON document, and
  // `ids: [{}, null, 7]` is a bug in a client, not a request to answer.
  const ids = raw.filter((value): value is string => typeof value === "string");
  if (ids.length === 0 || !ids.some(isScreenshotId)) {
    return Response.json(
      { error: "invalid_input", message: "No valid screenshot ids were sent." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await deleteScreenshots(ids);

    console.info(
      `screenshot.bulk_delete admin=${auth.id} requested=${ids.length} ` +
        `deleted=${result.deleted.length} failed=${result.failed.length} ` +
        `at=${new Date().toISOString()}`,
    );

    return Response.json(
      { ...result, requested: ids.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("DELETE /api/admin/screenshots failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Those screenshots could not be deleted. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
