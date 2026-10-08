import { apiUser } from "@/lib/authz";
import { revokeDeviceForUser } from "@/lib/monitorAuth";

/**
 * POST /api/account/workstations/disconnect — sign the Monitor out on one
 * machine.
 *
 * The remedy half of the workstations screen, and the reason the refresh window
 * is allowed to slide: a connection that renews itself indefinitely needs
 * somewhere a person can end it. A disconnected workstation stops on its very
 * next call, because `getDeviceContext` reads the row every time.
 *
 * **It does not end a shift and does not sign anybody out of the portal.** That
 * separation is the promise `revokeDevice` makes in `lib/monitorAuth.ts`, and
 * the confirm dialog on the screen repeats it in words, because "disconnect"
 * could reasonably be read as either.
 *
 * Ownership is the `where` clause, not a check in front of it:
 * `revokeDeviceForUser` puts `userId` in the query, so a device id belonging to
 * a colleague matches no row and comes back as the same 404 a missing one does.
 * The caller cannot ask a question about another agent's workstation, which is
 * a stronger property than being refused an answer to it.
 */
export async function POST(request: Request): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" } as const;

  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: noStore },
    );
  }

  const deviceId =
    typeof (body as { deviceId?: unknown }).deviceId === "string"
      ? (body as { deviceId: string }).deviceId
      : "";

  if (!deviceId) {
    return Response.json(
      { error: "missing_fields", message: "deviceId is required." },
      { status: 400, headers: noStore },
    );
  }

  const revoked = await revokeDeviceForUser(auth.id, deviceId);

  if (!revoked) {
    return Response.json(
      {
        error: "unknown_workstation",
        message: "That workstation is not connected.",
      },
      { status: 404, headers: noStore },
    );
  }

  console.info(`workstation ${deviceId} disconnected by user ${auth.id}`);

  return Response.json({ ok: true }, { headers: noStore });
}
