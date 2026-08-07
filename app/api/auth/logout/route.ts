import { LOGIN_PATH } from "@/lib/access";
import { destroySession } from "@/lib/session";

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
 * other site, which is a nuisance attack that costs nothing to close.
 *
 * Always 200, even with no session to destroy. Signing out is idempotent and
 * "you were not signed in" is not an error worth showing anyone.
 */
export async function POST(): Promise<Response> {
  await destroySession();

  return Response.json(
    { ok: true, redirectTo: LOGIN_PATH },
    { headers: { "Cache-Control": "no-store" } },
  );
}
