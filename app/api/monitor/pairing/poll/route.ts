import { clientIp } from "@/lib/loginThrottle";
import { sendMail } from "@/lib/mail";
import { prunePairings, redeemPairing } from "@/lib/monitorPairing";
import { pruneExpiredDevices } from "@/lib/monitorAuth";
import { MONITOR_PAIRING_POLL_LIMIT, rateLimitRefusal } from "@/lib/rateLimit";
import { buildWorkstationConnectedEmail } from "@/lib/workstationEmail";

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

  /*
   * Tell the agent, and do not let it matter whether the telling worked.
   *
   * This email is what stands in for a code the agent would otherwise have
   * typed: connecting takes one click, so noticing is part of the defence. But
   * it is detection, not a gate — refusing to connect because SMTP is down
   * would turn a notification into a dependency, and would strand an agent
   * whose approval already succeeded.
   */
  void sendMail(
    buildWorkstationConnectedEmail({
      to: result.user.email,
      deviceName: result.deviceName,
      platform: result.platform,
      portalUrl: portalUrlFor(request),
      connectedAt: new Date(),
    }),
  ).catch(() => {});

  return Response.json(
    { ok: true, state: "approved", tokens: result.tokens, user: result.user },
    { headers: noStore },
  );
}

/**
 * Where to point the one link in the notification email.
 *
 * `APP_ORIGIN` when the deployment sets it, because that is already this
 * application's statement of what it is called from outside. Otherwise the
 * request's own `Host`, which nginx constrains to this vhost's `server_name`
 * before anything reaches us — and `https`, because the app sits behind that
 * proxy on loopback and its own view of the scheme is always `http`.
 *
 * Deliberately not a new environment variable: `.env.example` promises that
 * authentication adds none, and this is a link in an email rather than
 * anything a decision rests on.
 */
function portalUrlFor(request: Request): string {
  const configured = process.env.APP_ORIGIN?.split(",")[0]?.trim();
  if (configured) return configured;

  const host = request.headers.get("host") ?? "localhost:3000";
  const scheme = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${scheme}://${host}`;
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
