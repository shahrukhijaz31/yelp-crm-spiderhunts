import { apiUser } from "@/lib/authz";
import { HEARTBEAT_SECONDS, heartbeatWorkSession } from "@/lib/workSessions";

/**
 * POST /api/work-session/heartbeat — "this browser is still open".
 *
 * The one thing standing between a closed laptop and a work session that runs
 * until the end of time. An open portal tab calls this every
 * {@link HEARTBEAT_SECONDS}; the row's `last_seen_at` moves, and a session
 * whose heartbeat stops is closed at that instant rather than at the moment
 * somebody eventually notices (see `lib/workSessions.ts`).
 *
 * **It takes no body.** There is nothing to send: whose session this is comes
 * from the session row `apiUser()` resolved in Postgres, so there is no user id
 * for a client to substitute and no way to beat somebody else's clock. That is
 * also why an agent calling this in a loop gains nothing — the duration is
 * `now - started_at` on a row they did not choose the start of, and extra beats
 * inside the grace window are indistinguishable from one.
 *
 * Returns the session's start instant so a tab that has been open across a
 * resume can correct its clock from the server rather than from its own
 * `setInterval`, which a sleeping machine will have got wrong.
 *
 * POST rather than GET: it writes, and a GET that writes gets prefetched.
 */
export async function POST(): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  try {
    const session = await heartbeatWorkSession(auth.id);
    return Response.json(
      { session, heartbeatSeconds: HEARTBEAT_SECONDS },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("POST /api/work-session/heartbeat failed:", error);
    // A missed beat costs nothing — the grace window is five of them wide — so
    // this answers rather than throwing a banner onto the agent's screen.
    return Response.json(
      { session: null, heartbeatSeconds: HEARTBEAT_SECONDS },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
