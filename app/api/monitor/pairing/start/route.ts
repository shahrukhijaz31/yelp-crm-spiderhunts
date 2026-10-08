import { clientIp } from "@/lib/loginThrottle";
import { startPairing, prunePairings } from "@/lib/monitorPairing";
import { MONITOR_PAIRING_START_LIMIT, rateLimitRefusal } from "@/lib/rateLimit";

/**
 * POST /api/monitor/pairing/start — a workstation asks to be connected.
 *
 * The first half of connecting the Monitor without a second sign-in. The
 * workstation calls this, shows nothing to the agent but a "waiting" screen,
 * opens the portal in their browser, and polls `../poll` until they approve.
 *
 * ---------------------------------------------------------------------------
 * This request names nobody, and that is the point
 * ---------------------------------------------------------------------------
 * There is no username, no email and no password in the body — only what the
 * machine calls itself, which is a label. So:
 *
 *   - it cannot be used to find out which accounts exist, which is the thing
 *     `/auth/login` can only blunt with timing equalisation
 *   - a workstation cannot ask to be connected *as* somebody. The account is
 *     written later, from the session of whoever approves it
 *   - the two secrets it returns are useless on their own: nothing becomes a
 *     credential until an authenticated agent says yes
 *
 * Unauthenticated by necessity — the caller has no credential yet; that is
 * what it is here to get. The bound on it is {@link MONITOR_PAIRING_START_LIMIT}
 * by source address, plus rows that expire in five minutes.
 */
export async function POST(request: Request): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" } as const;
  const ip = clientIp(request);

  const limited = await rateLimitRefusal(MONITOR_PAIRING_START_LIMIT, ip);
  if (limited) return limited;

  // A body is optional: a workstation that sends nothing at all still gets a
  // pairing, it just shows up on the approval screen as an unnamed machine.
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const device = (body as { device?: Record<string, unknown> } | null)?.device ?? {};
  const asString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;

  let started;
  try {
    started = await startPairing(
      {
        deviceName: asString(device.name) ?? asString(device.deviceName),
        platform: asString(device.platform),
        appVersion: asString(device.appVersion),
      },
      ip,
    );
  } catch (error) {
    console.error("POST /api/monitor/pairing/start failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: noStore },
    );
  }

  // Opportunistic housekeeping, as `/auth/verify` does. Not awaited: a slow
  // sweep must not hold up the workstation that triggered it.
  void prunePairings();

  /*
   * The verification URL is deliberately absent.
   *
   * The Monitor builds it from the portal address compiled into the build, so
   * a response cannot nominate a page for `shell.openExternal` to open on the
   * agent's desktop. See `src/main/services/pairing-url.ts` in the Monitor.
   */
  return Response.json(
    {
      ok: true,
      requestId: started.requestId,
      deviceCode: started.deviceCode,
      expiresAt: started.expiresAt,
      pollIntervalSeconds: started.pollIntervalSeconds,
    },
    { status: 201, headers: noStore },
  );
}
