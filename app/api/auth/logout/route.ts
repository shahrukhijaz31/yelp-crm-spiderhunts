import { LOGIN_PATH } from "@/lib/access";
import { csrfRefusal } from "@/lib/csrf";
import { destroySession, getSessionUser } from "@/lib/session";
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
 * **The work session is closed here too**, and the order of the three steps is
 * the whole design:
 *
 *   1. resolve who is signing out, while the cookie still means something;
 *   2. destroy the authentication session, which is the part that must happen
 *      whatever else does;
 *   3. close the shift.
 *
 * Step 3 last, and after step 2, because `endWorkSessionForLogout` decides
 * whether to stop the clock by counting the browsers that are *still* signed
 * in — so this one has to be gone before it counts. An agent signing out of
 * their phone while still working at their desk keeps their timer running;
 * signing out of the last browser stops it and writes the duration.
 *
 * It cannot fail the logout: it swallows its own errors, and a shift left open
 * by a database hiccup is closed by the next reconciliation sweep at its last
 * heartbeat.
 */
export async function POST(request: Request): Promise<Response> {
  const crossSite = csrfRefusal(request);
  if (crossSite) return crossSite;

  const user = await getSessionUser().catch(() => null);

  await destroySession();

  if (user) await endWorkSessionForLogout(user.id);

  return Response.json(
    { ok: true, redirectTo: LOGIN_PATH },
    { headers: { "Cache-Control": "no-store" } },
  );
}
