import { apiUser } from "@/lib/authz";
import { denyPairing } from "@/lib/monitorPairing";

/**
 * POST /api/account/workstations/deny — "that was not me".
 *
 * The button beside Connect on the approval screen, and the one that matters
 * if a request ever arrives that the agent did not start.
 *
 * ---------------------------------------------------------------------------
 * Why this asks for nothing but the id
 * ---------------------------------------------------------------------------
 * The person who should press Deny is precisely the person who has no idea
 * where the request came from. Any check that made them prove something about
 * the workstation would make the button useless in the only situation it
 * exists for.
 *
 * It needs a session, because a public denial endpoint would let anybody who
 * learned a request id cancel somebody's connection. It does not need to be
 * *their* pairing: a pending pairing belongs to nobody, so there is no owner to
 * compare against, and refusing one is a safe thing for any signed-in agent to
 * do — the worst case is a workstation told to start again.
 *
 * Always answers 200. "There was nothing to deny" is not a failure worth
 * reporting, and reporting it would say whether the id existed.
 */
export async function POST(request: Request): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" } as const;

  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const requestId =
    typeof (body as { requestId?: unknown }).requestId === "string"
      ? (body as { requestId: string }).requestId
      : "";

  if (requestId) {
    await denyPairing(requestId);
    // Who refused goes here rather than on the row: `user_id` means "the
    // account this was approved for", and a refusal approved nothing.
    console.info(`workstation pairing ${requestId} denied by user ${auth.id}`);
  }

  return Response.json({ ok: true }, { headers: noStore });
}
