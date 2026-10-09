import { LOGIN_PATH } from "@/lib/access";
import { csrfRefusal } from "@/lib/csrf";
import { destroyAllSessionsFor, destroySession, getSessionUser } from "@/lib/session";
import { revokeAllDevicesFor } from "@/lib/monitorAuth";
import { endWorkSessionForLogout } from "@/lib/workSessions";

/**
 * POST /api/auth/logout — end the session for real.
 *
 * `destroySession` deletes the row before clearing the cookie, so the token is
 * dead server-side the instant this returns. Pressing Back afterwards may well
 * paint a cached page, but every protected page re-reads the session on the
 * server and the API answers 401, so nothing behind the login is actually
 * reachable with the old cookie — there is no session left to reach it with.
 *
 * POST, not GET: a logout on GET can be triggered by an `<img>` tag on any
 * other site, which is a nuisance attack that costs nothing to close. A
 * cross-site POST closes the same nuisance from the other side (`lib/csrf.ts`)
 * — this route has no `apiUser()` guard to carry that check for it, because
 * signing out must work whether or not the session is still valid.
 *
 * Always 200, even with no session to destroy. Signing out is idempotent and
 * "you were not signed in" is not an error worth showing anyone.
 *
 * **Signing out ends the shift, and every other browser goes with it.** The
 * order of the steps is the design:
 *
 *   1. resolve who is signing out, while the cookie still means something;
 *   2. destroy this authentication session, which is the part that must happen
 *      whatever else does;
 *   3. destroy every other browser session the person has — an open tab
 *      elsewhere would otherwise heartbeat a new shift into existence within a
 *      minute, and a forgotten one used to keep the old shift running for
 *      hours;
 *   4. disconnect every SpiderHunts Monitor workstation the person has. Each
 *      one is refused on its next poll (within a minute), stops capturing and
 *      goes back to its connect screen; connecting it again is the usual
 *      approve-from-the-portal step;
 *   5. close the shift.
 *
 * Steps 3 to 5 cannot fail the logout: each swallows its own errors, and a
 * shift left open by a database hiccup is closed by the next reconciliation
 * sweep at its last heartbeat.
 */
export async function POST(request: Request): Promise<Response> {
  const crossSite = csrfRefusal(request);
  if (crossSite) return crossSite;

  const user = await getSessionUser().catch(() => null);

  await destroySession();

  if (user) {
    await destroyAllSessionsFor(user.id).catch((error) => {
      console.error(`Could not end the other sessions for ${user.id}:`, error);
    });
    // Every SpiderHunts Monitor this agent has goes too: its next request is
    // refused, it drops its credential and returns to its connect screen.
    await revokeAllDevicesFor(user.id);
    await endWorkSessionForLogout(user.id);
  }

  return Response.json(
    { ok: true, redirectTo: LOGIN_PATH },
    { headers: { "Cache-Control": "no-store" } },
  );
}
