import { revokeDevice } from "@/lib/monitorAuth";

/**
 * POST /api/monitor/auth/logout — disconnect this workstation.
 *
 * **This is not a portal logout, and must never become one.** It revokes one
 * `monitor_devices` row and touches nothing else: not the agent's browser
 * sessions, not their work session, not their clock. An agent who closes the
 * desktop application is still sitting at their desk with the worklist open,
 * and ending their shift here would silently lose them the rest of the day.
 * The two authentication contexts are separate in both directions — signing out
 * of the portal likewise leaves a connected workstation alone, until its own
 * tokens expire.
 *
 * Accepts either token in the body, because the client may hold only one by the
 * time it gets here, and always answers 200: signing out is idempotent, and
 * "there was nothing to revoke" is not something to report. A client that
 * cannot reach the server still discards its stored credential locally, so the
 * workstation is disconnected either way.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty or malformed body is fine — the Authorization header below may
    // be all the client has, and a logout should not fail on a parse error.
  }

  const payload = body as { refreshToken?: unknown };

  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  const accessToken = scheme.toLowerCase() === "bearer" ? rest.join(" ").trim() : "";

  await revokeDevice({
    accessToken: accessToken || null,
    refreshToken: typeof payload.refreshToken === "string" ? payload.refreshToken : null,
  });

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
