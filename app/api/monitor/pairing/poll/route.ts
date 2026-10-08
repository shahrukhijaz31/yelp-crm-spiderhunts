import { clientIp } from "@/lib/loginThrottle";
import { prunePairings, redeemPairing } from "@/lib/monitorPairing";
import { pruneExpiredDevices } from "@/lib/monitorAuth";
import { MONITOR_PAIRING_POLL_LIMIT, rateLimitRefusal } from "@/lib/rateLimit";

/**
 * POST /api/monitor/pairing/poll — has the agent approved this workstation yet?
 *
 * The second half of connecting the Monitor. The workstation holds the device
 * code from `../start` and asks every five seconds until it is told something
 * final. On approval this answers with exactly what `/auth/verify` answers —
 * the same tokens, the same user — so the client stores a paired credential
 * through the same code path as one earned with a password and a code.
 *
 * ---------------------------------------------------------------------------
 * Pending is a success
 * ---------------------------------------------------------------------------
 * `{ ok: true, state: "pending" }` with a 200, not an error. The request
 * succeeded; the answer is "not yet". RFC 8628 models this as an OAuth error
 * code, but in this codebase `{ error }` means the request failed, and a client
 * that has to tell one kind of error from another to know whether to keep
 * waiting is a client that will eventually get it wrong.
 *
 * ---------------------------------------------------------------------------
 * The final answers, and why 410
 * ---------------------------------------------------------------------------
 *   401  the device code resolves to nothing
 *   403  the agent said no, or the account may not connect a workstation
 *   410  the pairing existed and is gone — expired, or already collected
 *
 * 410 is new to this API's vocabulary and is worth the addition: "that used to
 * exist" and "that never existed" lead to different sentences on the
 * workstation, and the one for a consumed pairing — somebody already collected
 * this — is the one worth showing a person.
 */
export async function POST(request: Request): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" } as const;

  // Before the lookup, so an unknown code cannot buy an unlimited stream of
  // indexed reads.
  const limited = await rateLimitRefusal(MONITOR_PAIRING_POLL_LIMIT, clientIp(request));
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: noStore },
    );
  }

  const deviceCode =
    typeof (body as { deviceCode?: unknown }).deviceCode === "string"
      ? (body as { deviceCode: string }).deviceCode
      : "";

  if (!deviceCode) {
    return Response.json(
      { error: "missing_fields", message: "deviceCode is required." },
      { status: 400, headers: noStore },
    );
  }

  let result;
  try {
    result = await redeemPairing(deviceCode);
  } catch (error) {
    console.error("POST /api/monitor/pairing/poll failed:", error);
    // A database outage is not a refused pairing. 503 keeps the workstation
    // waiting instead of sending it back to the sign-in screen.
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: noStore },
    );
  }

  if (result.state === "pending") {
    return Response.json({ ok: true, state: "pending" }, { headers: noStore });
  }

  if (result.state === "failed") {
    return Response.json({ error: result.code }, { status: statusFor(result.code), headers: noStore });
  }

  // Same housekeeping beat as `/auth/verify`, now that a connection has been
  // made and this request is not holding anybody up.
  void prunePairings();
  void pruneExpiredDevices();

  console.info(`workstation connected by pairing for user ${result.userId}`);

  return Response.json(
    { ok: true, state: "approved", tokens: result.tokens, user: result.user },
    { headers: noStore },
  );
}

function statusFor(code: string): number {
  switch (code) {
    case "invalid_device_code":
      return 401;
    case "pairing_denied":
    case "account_disabled":
    case "role_not_permitted":
      return 403;
    case "pairing_expired":
    case "pairing_consumed":
      return 410;
    default:
      // `unknown_user` lands here: the approving account was deleted between
      // the click and the poll, which is not a thing the workstation can fix.
      return 403;
  }
}
