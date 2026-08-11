import { createSession } from "./session";
import { markLoggedIn } from "./userDb";
import { openOrResumeWorkSession } from "./workSessions";

/**
 * Everything that happens at the moment somebody becomes signed in.
 *
 * This is the tail that used to sit at the bottom of `POST /api/auth/login`,
 * lifted into one function because two routes now reach it — the OTP
 * verification route, and the login route on the admin path that currently
 * skips OTP. Two copies of "what it means to sign in" would be two places to
 * forget the work-session clock, and the one that forgot would be silently
 * wrong in the reports rather than loudly broken.
 *
 * Nothing about roles is decided here. It takes a user id, and the session it
 * creates carries an opaque token — the role is read from the database on every
 * subsequent request, exactly as it always was.
 */
export async function completeSignIn(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null },
): Promise<void> {
  // Throws on failure, deliberately: a sign-in whose session could not be
  // written is a failed sign-in, and the caller turns that into a 503.
  await createSession(userId, meta);

  await markLoggedIn(userId);

  /*
   * Start the work session — the shift the "active time" figures are summed
   * from. Awaited, not fired and forgotten, so the clock is running in Postgres
   * before the browser is told to go to the portal; the timer the user then
   * sees is read from that row rather than started by the page load, which is
   * what makes it survive a refresh.
   *
   * `openOrResumeWorkSession` *resumes* an open session rather than opening a
   * second one, so signing in from a second tab, window or device adds no time
   * at all. It never throws — a clock that could not be started must not cost
   * somebody their sign-in.
   */
  await openOrResumeWorkSession(userId);
}
