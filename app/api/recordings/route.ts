import { apiModule } from "@/lib/authz";
import { listRecordingsFor } from "@/lib/recordings";

/**
 * GET /api/recordings — every call recording this caller may see, keyed by lead.
 *
 * The worklist needs one thing the leads query does not carry: whether a row
 * already has audio attached, so the quick-upload button beside Status can show
 * an "attached" state instead of an upload arrow. This answers that in one
 * request for the whole screen rather than one per row, and it is a *read* of
 * the same policy the rest of the feature enforces — `listRecordingsFor`
 * filters in the `where` clause, so an agent is never sent a row describing
 * another agent's call.
 *
 * Deliberately not folded into `GET /api/leads`. That route is the paged
 * worklist query and is asked again on every tab, filter, sort and page change;
 * recordings change on upload and nowhere else, so they are fetched once and
 * kept. Keeping them apart also means nothing about the list query had to move
 * to make the button work.
 *
 * The summaries are returned whole rather than as a set of ids: `canManage` is
 * the server's word on whether the caller may replace what is there, and the
 * button is drawn from it rather than from a role check written again in the
 * browser.
 */
export async function GET(): Promise<Response> {
  // Call recordings belong to the Leads module — they hang off a lead and are
  // keyed by one. An account without that module has no worklist to draw them
  // beside, and is refused here as well as there.
  const auth = await apiModule("leads");
  if (auth instanceof Response) return auth;

  try {
    const recordings = await listRecordingsFor(auth);
    return Response.json({ recordings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/recordings failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not load call recordings. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
