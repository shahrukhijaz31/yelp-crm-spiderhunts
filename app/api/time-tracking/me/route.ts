import { apiUser } from "@/lib/authz";
import { resolveRange } from "@/lib/performanceRules";
import { agentTimeTracking } from "@/lib/timeTracking";

/**
 * GET /api/time-tracking/me — the caller's own time and activity record.
 *
 * The exact construction `GET /api/performance/me` uses, and it is the whole of
 * the authorization story: `agentTimeTracking` is called with `auth.id` from the
 * session row in Postgres, and **no user id is read from the request at all**.
 * There is no query parameter, no header and no body field that could make this
 * return somebody else's day — not because a check refuses one, but because
 * there is nothing to check. The admin view of the same data is
 * `/api/reports/time`, a different endpoint behind `apiAdmin()`.
 *
 * That is also why this path is deliberately absent from `ADMIN_PREFIXES`: it
 * is a rule about *whose* row rather than about a path, and an administrator has
 * a working day too.
 *
 * The response contains screenshot **counts and capture times, never ids and
 * never images**. `lib/access.ts` is explicit that no agent may see any
 * screenshot including their own, and this endpoint does not become the way
 * around that. What the agent is entitled to — and what monitoring being honest
 * requires — is knowing that captures are happening and how many there were.
 *
 * Read-only. Nothing on this path writes a row of any kind; in particular it
 * does not touch `work_sessions`, so opening this screen cannot start, extend or
 * alter a shift. The clock is still the browser heartbeat's business alone.
 */
export async function GET(): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  try {
    const payload = await agentTimeTracking(
      auth.id,
      resolveRange("today"),
      resolveRange("last7"),
    );

    return Response.json(payload, {
      // `private` as well as `no-store`: this is one named person's activity
      // record and must not sit in a shared cache under any circumstances.
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("GET /api/time-tracking/me failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not load your time tracking. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
