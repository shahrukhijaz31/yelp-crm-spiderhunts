import { apiUser } from "@/lib/authz";
import { HEARTBEAT_SECONDS } from "@/lib/performanceRules";
import { getWorkClock, heartbeatWorkSession } from "@/lib/workSessions";

/**
 * POST /api/work-session/heartbeat — "this browser is still open", and the
 * clock that goes with it.
 *
 * Two jobs on one round trip. The beat is what stands between a closed laptop
 * and a work session that runs until the end of time: it moves `last_seen_at`,
 * and a session whose beat stops is closed at that instant rather than when
 * somebody eventually notices (see `lib/workSessions.ts`). The response then
 * carries the current {@link WorkClock}, so the figures on screen are re-anchored
 * to the database once a minute instead of being trusted to a browser timer.
 *
 * **It takes no body.** There is nothing to send: whose session this is comes
 * from the session row `apiUser()` resolved in Postgres, so there is no user id
 * for a client to substitute and no way to beat — or read — somebody else's
 * clock. That is also why calling it in a loop gains an agent nothing: the
 * duration is `now - started_at` on a row they did not choose the start of, and
 * extra beats inside the grace window are indistinguishable from one.
 *
 * POST rather than GET: it writes, and a GET that writes gets prefetched.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await apiUser(request);
  if (auth instanceof Response) return auth;

  try {
    const clock = await heartbeatWorkSession(auth.id);
    return Response.json(
      { clock, heartbeatSeconds: HEARTBEAT_SECONDS },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("POST /api/work-session/heartbeat failed:", error);

    // A missed beat costs nothing — the grace window is five of them wide — so
    // this answers rather than throwing a banner onto the agent's screen. The
    // clock is still attempted: a failure to *write* the beat is no reason to
    // stop telling the browser what the database says.
    const clock = await getWorkClock(auth.id).catch(() => null);
    return Response.json(
      { clock, heartbeatSeconds: HEARTBEAT_SECONDS },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
