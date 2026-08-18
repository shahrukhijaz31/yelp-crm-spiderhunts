import { apiModule } from "@/lib/authz";
import { DemoWebsiteError } from "@/lib/demoWebsiteRules";
import { demoSummaryFor, setDemoLink } from "@/lib/demoWebsites";

/**
 * The demo link on one lead.
 *
 *   GET    the lead's demo metadata — the link and the image's shape
 *   PATCH  set or clear the link
 *
 * ---------------------------------------------------------------------------
 * Why this is a route of its own rather than part of `PATCH /api/leads/:id`
 * ---------------------------------------------------------------------------
 * Because it is granted differently. The lead's own fields — status, notes,
 * callback — are editable by anyone with either module, and the demo link is
 * editable only with the Demo Websites module. Folding it into the lead PATCH
 * would mean one handler holding two permission rules and picking between them
 * by inspecting which keys the body happened to contain, which is exactly the
 * shape of check that gets a case wrong later.
 *
 * It is also a genuinely different object. This writes `demo_websites`, a row
 * that may not exist yet and is created on first save; the lead PATCH writes
 * `leads` and records an activity entry. Keeping them apart means neither can
 * accidentally do the other's bookkeeping.
 *
 * ---------------------------------------------------------------------------
 * What it cannot touch
 * ---------------------------------------------------------------------------
 * Any lead field. There is no `name`, `phone`, `status`, `notes` or `owner` in
 * this handler, in `setDemoLink`, or in the table it writes — the demo view
 * reads all of those from `leads` on every request, so there is nothing here to
 * fall out of step. A body carrying them sets nothing, because nothing reads
 * them.
 *
 * Nor any ownership, role or permission field. `updatedById` is `auth.id` from
 * the session row; the request has no author field for a caller to set.
 *
 * `id` is a selector and never a claim: it picks a lead the caller must already
 * hold the module to reach, and the module grants the whole pool, so there is
 * no boundary for a changed id to cross.
 */

const noStore = { "Cache-Control": "no-store" } as const;

function notFound(): Response {
  return Response.json(
    { error: "not_found", message: "No such lead." },
    { status: 404, headers: noStore },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiModule("demoWebsites");
  if (auth instanceof Response) return auth;

  const { id } = await params;

  try {
    // Null is a perfectly good answer and not a 404: it means "this lead has no
    // demo image and no demo link yet", which is true of almost every lead and
    // is what the empty cells on the demo screen are drawn from.
    const demo = await demoSummaryFor(id);
    return Response.json({ demo }, { headers: noStore });
  } catch (error) {
    console.error(`GET /api/leads/${id}/demo failed:`, error);
    return Response.json(
      { error: "server_error", message: "Could not read the demo details." },
      { status: 500, headers: noStore },
    );
  }
}

/**
 * PATCH — set or clear the demo link.
 *
 * `{ "demoUrl": "https://…" }` sets it, `{ "demoUrl": null }` clears it. The
 * URL is validated server-side by `normaliseDemoUrl`: http and https only,
 * rejecting `javascript:`, `data:`, `file:`, embedded credentials and anything
 * with no domain. The cell runs the same check before submitting, which saves a
 * round trip and protects nothing — this is the one that decides what is
 * stored.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiModule("demoWebsites", request);
  if (auth instanceof Response) return auth;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: noStore },
    );
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  if (!("demoUrl" in payload)) {
    return Response.json(
      { error: "no_changes", message: "Nothing to change." },
      { status: 400, headers: noStore },
    );
  }

  try {
    // `auth.id` — the user the session row resolved to, never anything the body
    // claimed. There is no author field in the request.
    const demo = await setDemoLink(id, payload.demoUrl, auth.id);
    if (!demo) return notFound();

    return Response.json({ demo }, { headers: noStore });
  } catch (error) {
    if (error instanceof DemoWebsiteError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }
    console.error(`PATCH /api/leads/${id}/demo failed:`, error);
    return Response.json(
      { error: "server_error", message: "The demo link was not saved." },
      { status: 500, headers: noStore },
    );
  }
}
