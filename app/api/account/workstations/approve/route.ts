import { apiUser } from "@/lib/authz";
import { clientIp } from "@/lib/loginThrottle";
import { approvePairing } from "@/lib/monitorPairing";
import { rateLimitRefusal, WORKSTATION_APPROVE_LIMIT } from "@/lib/rateLimit";

/**
 * POST /api/account/workstations/approve — "yes, connect that workstation".
 *
 * The browser half of connecting the Monitor, and the moment a pending pairing
 * that named nobody becomes one belonging to the person clicking.
 *
 * ---------------------------------------------------------------------------
 * Why this is not under `/api/monitor`
 * ---------------------------------------------------------------------------
 * That route group is documented as unreachable from a browser session and
 * never called by the web app (`app/api/monitor/README.md`), and the rule earns
 * its keep: it is why `monitor_devices` and `sessions` cannot be confused for
 * one another. This endpoint is the opposite kind of thing — a signed-in
 * browser, a cookie, a CSRF check — so it lives with the other account screens.
 *
 * ---------------------------------------------------------------------------
 * What it checks
 * ---------------------------------------------------------------------------
 *   `apiUser`        a live session, then the same-origin rule, in one line.
 *                    A link from somewhere else cannot post here at all
 *   the network      `approvePairing` compares the address against the one the
 *                    workstation started from — the check that makes a phishing
 *                    link useless now that there is no code to type
 *   eligibility      re-read from Postgres inside `approvePairing`, so an
 *                    administrator is refused here rather than three seconds
 *                    later on the workstation
 *
 * The account comes from `auth.id` and from nowhere else. There is no field in
 * this body that names a user, which is the same property the screenshot upload
 * has: not a check that could be forgotten, but an absence.
 */
export async function POST(request: Request): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" } as const;

  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

  const limited = await rateLimitRefusal(WORKSTATION_APPROVE_LIMIT, auth.id);
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

  const requestId =
    typeof (body as { requestId?: unknown }).requestId === "string"
      ? (body as { requestId: string }).requestId
      : "";

  if (!requestId) {
    return Response.json(
      { error: "missing_fields", message: "requestId is required." },
      { status: 400, headers: noStore },
    );
  }

  let result;
  try {
    result = await approvePairing(requestId, auth.id, clientIp(request));
  } catch (error) {
    console.error("POST /api/account/workstations/approve failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not connect that workstation." },
      { status: 503, headers: noStore },
    );
  }

  if (!result.ok) {
    return Response.json(
      { error: result.code, message: messageFor(result.code) },
      { status: statusFor(result.code), headers: noStore },
    );
  }

  // The audit trail, such as it is — the same `console.info` line the password
  // change keeps. Never the device code, which this endpoint never sees.
  console.info(`workstation pairing ${requestId} approved by user ${auth.id}`);

  return Response.json({ ok: true, deviceName: result.deviceName }, { headers: noStore });
}

function statusFor(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "already_handled":
      return 409;
    case "different_network":
    case "account_disabled":
    case "role_not_permitted":
    case "unknown_user":
      return 403;
    default:
      return 400;
  }
}

function messageFor(code: string): string {
  switch (code) {
    case "not_found":
      return "That request has expired or does not exist. Press Connect in the Monitor again.";
    case "already_handled":
      return "That request has already been dealt with.";
    case "different_network":
      return "Open the portal on the same computer as the Monitor, then try again.";
    case "account_disabled":
    case "unknown_user":
      return "This account has been disabled.";
    case "role_not_permitted":
      return "SpiderHunts Monitor is for agent accounts.";
    default:
      return "Could not connect that workstation.";
  }
}
