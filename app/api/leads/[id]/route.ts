import { apiUser } from "@/lib/authz";
import { LeadEditError, parseLeadEdits, updateLeadFields } from "@/lib/leadDb";

/**
 * PATCH /api/leads/:id — persist one inline edit.
 *
 * This is the endpoint `LeadsProvider.updateLead` was always described as
 * waiting for. It takes a *partial* body — `{ "status": "interested" }`,
 * `{ "notes": "..." }`, `{ "callbackDate": null }` — and writes only the keys
 * present, so the status dropdown and the notes box can never clobber each
 * other when two edits land close together.
 *
 * The client updates optimistically and does not wait on this response, so the
 * body is returned mainly for debugging and for the rollback path: on a
 * non-2xx the provider puts the previous value back.
 *
 * Open to both roles. Status, notes and callbacks are the agent's day job, and
 * `parseLeadEdits` is a whitelist — there is no field reachable through this
 * body that an agent should not be setting, and nothing here can touch a user
 * or a role.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  let edits;
  try {
    edits = parseLeadEdits(body);
  } catch (error) {
    if (error instanceof LeadEditError) {
      return Response.json({ error: "invalid_field", message: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const lead = await updateLeadFields(id, edits);
    if (!lead) {
      return Response.json(
        {
          error: "not_found",
          message: `No lead with id ${id}. It may have been replaced by a newer CSV import.`,
        },
        { status: 404 },
      );
    }

    return Response.json({ lead }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`PATCH /api/leads/${id} failed:`, error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. The change was not saved.",
      },
      { status: 503 },
    );
  }
}
