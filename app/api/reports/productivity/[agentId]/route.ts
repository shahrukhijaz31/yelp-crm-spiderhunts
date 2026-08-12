import { resolveTimesheetRange } from "@/lib/activityRules";
import { apiAdmin } from "@/lib/authz";
import { agentProductivity } from "@/lib/productivity";

/**
 * GET /api/reports/productivity/:agentId — one agent's score, with the working
 * shown. ADMIN only.
 *
 * `apiAdmin()` first, as everywhere under `/api/reports`. The id in the path is
 * a **filter** — which agent is being looked at — and never a claim about who is
 * looking: the caller's identity comes from the session row in Postgres, and
 * nothing in the URL contributes to it. An agent who puts their own id here
 * still gets a 403, because the check that refuses them happens before the
 * segment is read.
 *
 * **An id that names an administrator is a 404**, exactly as an id that names
 * nobody is. Administrators are not scored, so there is nothing here to return
 * for one, and answering differently for the two cases would describe the
 * account list to somebody who asked about a score. The rule is enforced in
 * `agentProductivity` by a database predicate on `role`, not by anything the
 * caller sent.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const { agentId } = await params;
  const range = resolveTimesheetRange(new URL(request.url).searchParams);

  try {
    const payload = await agentProductivity(agentId, range);
    if (!payload) {
      return Response.json(
        { error: "not_found", message: "No such agent." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error(`GET /api/reports/productivity/${agentId} failed:`, error);
    return Response.json(
      { error: "server_error", message: "Could not load that agent. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
