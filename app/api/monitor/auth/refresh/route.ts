import { refreshDeviceTokens } from "@/lib/monitorAuth";

/**
 * POST /api/monitor/auth/refresh — exchange a refresh token for a new pair.
 *
 * The only endpoint the desktop client reaches without an access token, and the
 * reason its stored credential survives a restart. Rotation happens inside
 * `refreshDeviceTokens`: the presented refresh token is dead the moment this
 * returns, so a copy taken from disk stops working as soon as the real
 * workstation next refreshes.
 *
 * A refusal here is final — the client discards its stored token and shows the
 * sign-in screen. That is the whole of "expired authentication is handled
 * cleanly": there is no state in which the Monitor keeps retrying a credential
 * the server has already refused.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const refreshToken =
    typeof (body as { refreshToken?: unknown }).refreshToken === "string"
      ? ((body as { refreshToken: string }).refreshToken)
      : "";

  let result;
  try {
    result = await refreshDeviceTokens(refreshToken);
  } catch (error) {
    console.error("POST /api/monitor/auth/refresh: refresh failed:", error);
    // A database outage is emphatically *not* an invalid token — answering 401
    // here would sign a working agent out because the server had a bad minute.
    // 503 tells the client to keep its credential and try again.
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!result.ok) {
    return Response.json(
      { error: result.code },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { ok: true, tokens: result.tokens, user: result.user },
    { headers: { "Cache-Control": "no-store" } },
  );
}
