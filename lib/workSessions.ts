import { Prisma } from "./generated/prisma/client";
import { HEARTBEAT_SECONDS } from "./performanceRules";
import { prisma } from "./prisma";

/**
 * Work sessions: how long somebody was actually here.
 *
 * A work session is a **shift**, and it deliberately is not the same row as the
 * authentication session in `lib/session.ts`. That table is one row per browser
 * cookie and is deleted at logout, which makes it useless for reporting twice
 * over: it is gone the moment it becomes interesting, and there is one of them
 * per device. This table keeps at most one *open* row per user, keeps it after
 * it closes, and is what every "active time" figure in the portal sums.
 *
 * The two live side by side rather than one replacing the other. Authentication
 * still owns who you are and when you are thrown out; this only observes.
 * Nothing here can extend, shorten or invalidate a login, so a bug in this file
 * cannot become a security problem — the worst it can do is mis-measure a day.
 *
 * ---------------------------------------------------------------------------
 * Three problems the shape of this table answers
 * ---------------------------------------------------------------------------
 *
 * **Multiple tabs, windows and browsers (requirement: no time inflation).**
 * Signing in *resumes* the open session when there is one rather than opening a
 * second — {@link openOrResumeWorkSession}. So a second tab adds nothing, a
 * second browser adds nothing, and a phone signed in beside a laptop adds
 * nothing: the measurement is wall-clock presence and it is counted once. The
 * invariant "at most one open row per user" is enforced in that one function,
 * inside a transaction, and {@link reconcileStaleWorkSessions} collapses any
 * duplicate that a genuinely simultaneous double sign-in could still slip past
 * it. A partial unique index would say the same thing to Postgres, but Prisma
 * cannot express one, and an index the schema does not know about shows up as
 * drift on the next migration — a silent trap for the next person.
 *
 * **The browser that never says goodbye.** Nothing waits for the logout button.
 * An open portal tab heartbeats every {@link HEARTBEAT_SECONDS}; a session
 * whose heartbeat has stopped for {@link STALE_MS} is *stale*, and is closed at
 * its own `lastSeenAt` rather than at the moment somebody noticed. A closed
 * laptop therefore costs at most one grace window of over-count, and never a
 * clock that runs forever. Stale sessions are swept at login (this app has no
 * cron — see `pruneExpiredSessions` for the same reasoning) and, so that a
 * report is never wrong while waiting for someone to sign in, are *also*
 * clamped on read by {@link OPEN_SESSION_END_SQL}.
 *
 * **Logging out of one device while working on another.** Logout closes the
 * shift only when the person has no other live authentication session left
 * (see {@link endWorkSessionForLogout}). Signing out of a phone does not stop
 * the clock on the desk they are still sitting at.
 *
 * ---------------------------------------------------------------------------
 * Active time vs login time
 * ---------------------------------------------------------------------------
 * Today the heartbeat means "the portal is open in a browser", so a duration
 * here is *authenticated session time*, which is what was asked for. Real
 * idle detection would change what the heartbeat is sent *on* — the client
 * stops beating after N minutes without input — and would change neither this
 * file's queries nor the table. That is the whole reason the beat is a write to
 * `lastSeenAt` rather than a timer in React: the definition of "active" lives
 * on one side of one HTTP call.
 */

/*
 * The heartbeat interval lives in `lib/performanceRules.ts` — the browser sets
 * its timer from it and the staleness window below is derived from it, so the
 * two ends cannot drift into disagreeing about what a dead session is. It is
 * re-exported here because this is the module the server side reads it from.
 */
export { HEARTBEAT_SECONDS };

/**
 * How long after the last heartbeat a session is presumed dead.
 *
 * Five beats. Generous enough that a laptop lid closed over lunch, a sleeping
 * phone or a minute of bad wifi does not chop a shift in half, tight enough
 * that a crash costs five minutes rather than the rest of the day.
 */
const STALE_MS = 5 * HEARTBEAT_SECONDS * 1000;

/*
 * Prisma stores `DateTime` as `timestamp(3)` — no timezone — holding UTC. Two
 * consequences run through every statement in this file and in
 * `lib/performance.ts`, and neither is optional:
 *
 *   - Postgres's `now()` is a `timestamptz` rendered in the *server's* local
 *     timezone, so comparing it against these columns is wrong by the server's
 *     offset. `now() AT TIME ZONE 'UTC'` is the same instant expressed as the
 *     naive UTC timestamp the columns actually hold.
 *   - A bound `Date` is serialised by the driver with an offset, which the
 *     column then has to reinterpret. Binding `date.toISOString()` and casting
 *     with `::timestamp` removes the ambiguity: Postgres parses the string,
 *     discards the `Z`, and compares UTC against UTC.
 *
 * Both live here rather than in the reporting module because this is the lower
 * of the two files and the definitions have to be the same in both.
 */

/** `now()`, as the naive-UTC timestamp the columns are stored in. */
export const NOW_UTC_SQL = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** An instant as an unambiguous bound parameter. See the note above. */
export function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamp`;
}

/**
 * When an *open* session should be treated as having ended, as SQL.
 *
 * `least(now, last_seen_at + grace)` — a live session ends "now" (its clock is
 * still running), and a dead one ended one grace window after its last
 * heartbeat. This is what stops a browser that crashed an hour ago from
 * reporting an hour of work before anybody happens to sign in and trigger the
 * sweep, and it means the figure a report shows is the same figure the sweep
 * will eventually write to `ended_at`.
 *
 * Kept here, next to {@link STALE_MS}, so the read path and the write path
 * cannot drift apart into two different definitions of a dead session.
 */
export const OPEN_SESSION_END_SQL = Prisma.sql`least(${NOW_UTC_SQL}, ws.last_seen_at + interval '${Prisma.raw(String(STALE_MS / 1000))} seconds')`;

/**
 * Seconds of a session that fall inside [from, to), whether it is open or
 * closed — the expression every "active time" total in the app is built from.
 *
 * Clamped at both ends rather than counted whole, so a shift that began before
 * the window or runs past it contributes only the part inside it. Without the
 * clamp, "how long did Umar work today" would include the evening before for
 * anyone who never signed out. `greatest(..., 0)` because a session entirely
 * outside the window clamps to a negative interval, and a negative shift added
 * to a total is worse than no row at all.
 */
export function overlapSecondsSql(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    greatest(
      0,
      extract(epoch FROM (
        least(coalesce(ws.ended_at, ${OPEN_SESSION_END_SQL}), ${utc(to)})
        - greatest(ws.started_at, ${utc(from)})
      ))
    )
  `;
}

export interface ActiveWorkSession {
  id: string;
  /** ISO instant. The timer in the UI counts up from this. */
  startedAt: string;
}

/**
 * Start a shift, or adopt the one already running.
 *
 * Called from the login route, after the authentication session exists. The
 * whole multiple-tab policy is these few lines:
 *
 *   - an open session that is still beating is **returned as-is**, so a second
 *     sign-in anywhere adds no row and no time;
 *   - an open session that has gone quiet is **closed at its last heartbeat**
 *     and a fresh one opened, so yesterday's crash does not silently absorb
 *     today;
 *   - otherwise a new one starts.
 *
 * In a transaction because the read decides what the write does, and two
 * sign-ins racing each other must not both conclude "there is no open session".
 * `Serializable` would close the last theoretical gap; it is not used because
 * this runs on every login, the loser of that race is corrected by the next
 * sweep, and the cost of being wrong is a duplicate row in a reporting table.
 *
 * Never throws into the caller's face: signing in must not fail because the
 * clock could not be started. The caller logs and carries on.
 */
export async function openOrResumeWorkSession(
  userId: string,
): Promise<ActiveWorkSession | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);

  return prisma
    .$transaction(async (tx) => {
      const open = await tx.workSession.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: "asc" },
        select: { id: true, startedAt: true, lastSeenAt: true },
      });

      if (open && open.lastSeenAt > staleBefore) {
        // Still beating — this is the same shift. Touch it so a resume from a
        // fresh browser counts as presence straight away rather than waiting a
        // minute for the first heartbeat.
        await tx.workSession.update({
          where: { id: open.id },
          data: { lastSeenAt: now },
        });
        return { id: open.id, startedAt: open.startedAt.toISOString() };
      }

      if (open) {
        await closeSessionTx(tx, open.id, open.startedAt, open.lastSeenAt, "timeout");
      }

      const created = await tx.workSession.create({
        data: { userId, startedAt: now, lastSeenAt: now },
        select: { id: true, startedAt: true },
      });

      return { id: created.id, startedAt: created.startedAt.toISOString() };
    })
    .catch((error) => {
      console.error(`Could not open a work session for ${userId}:`, error);
      return null;
    });
}

/** The shift currently running for this user, or null. Read on every page load. */
export async function getActiveWorkSession(
  userId: string,
): Promise<ActiveWorkSession | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);

  const open = await prisma.workSession
    .findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: "asc" },
      select: { id: true, startedAt: true, lastSeenAt: true },
    })
    .catch(() => null);

  if (!open) return null;

  // A session that has stopped beating is not "the session you are in" even
  // though its row is still open — the sweep simply has not reached it. Saying
  // so here keeps the timer honest between a crash and the next login.
  if (open.lastSeenAt <= staleBefore) return null;

  return { id: open.id, startedAt: open.startedAt.toISOString() };
}

/**
 * The heartbeat: "this browser is still open".
 *
 * Scoped by `userId` and nothing else — the caller is the session user, so
 * there is no id in the request body and therefore nothing to tamper with. A
 * user cannot touch anybody's clock but their own, whatever they send.
 *
 * Opens a session if there is none. That is not a back door into starting a
 * shift without signing in (the route is behind `apiUser`), it is what makes
 * the feature survive its own deployment: everyone already signed in when this
 * shipped has no open row, and their clock starts at their next heartbeat
 * rather than requiring them to sign out and back in.
 */
export async function heartbeatWorkSession(
  userId: string,
): Promise<ActiveWorkSession | null> {
  const active = await getActiveWorkSession(userId);
  if (!active) return openOrResumeWorkSession(userId);

  await prisma.workSession
    .update({ where: { id: active.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {
      // Bookkeeping. A missed beat costs nothing: the next one lands, and the
      // grace window is five of them wide.
    });

  return active;
}

/**
 * End the shift because somebody pressed Sign out.
 *
 * **Only if this was their last browser.** `destroySession` has already deleted
 * the row for the browser doing the signing out, so what is counted here is
 * what is left; if another live authentication session remains, the person is
 * still working somewhere else and the clock keeps running. Signing out of a
 * phone must not stop the timer on the desk they are sitting at.
 *
 * Ordering matters and is the caller's responsibility: this runs *after*
 * `destroySession`, which is why the current browser is not in the count.
 */
export async function endWorkSessionForLogout(userId: string): Promise<void> {
  try {
    const now = new Date();

    const otherLiveSessions = await prisma.session.count({
      where: { userId, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
    });
    if (otherLiveSessions > 0) return;

    const open = await prisma.workSession.findMany({
      where: { userId, endedAt: null },
      select: { id: true, startedAt: true, lastSeenAt: true },
    });

    for (const session of open) {
      await closeSessionTx(prisma, session.id, session.startedAt, now, "logout");
    }
  } catch (error) {
    // Signing out must always succeed. A shift left open here is closed by the
    // next sweep at its last heartbeat, which is the same answer a few minutes
    // later.
    console.error(`Could not close the work session for ${userId}:`, error);
  }
}

/**
 * Housekeeping: close shifts whose browser stopped talking, and collapse any
 * duplicate open row.
 *
 * Called opportunistically from the login route beside `pruneExpiredSessions`,
 * for the same reason given there — this app deploys as two short-lived
 * blue/green processes, so a background interval would be an unreliable place
 * to put it. Reports do not depend on it having run: {@link OPEN_SESSION_END_SQL}
 * clamps an un-swept session to the same instant this would have written.
 */
export async function reconcileStaleWorkSessions(): Promise<void> {
  try {
    const staleBefore = new Date(Date.now() - STALE_MS);

    const stale = await prisma.workSession.findMany({
      where: { endedAt: null, lastSeenAt: { lte: staleBefore } },
      select: { id: true, startedAt: true, lastSeenAt: true },
      // Bounded: a sweep is a courtesy on somebody's login request, not a job.
      // Whatever it misses is caught by the next one, and is correct on read
      // in the meantime.
      take: 200,
    });

    for (const session of stale) {
      await closeSessionTx(prisma, session.id, session.startedAt, session.lastSeenAt, "timeout");
    }

    await collapseDuplicateOpenSessions();
  } catch (error) {
    console.error("Reconciling work sessions failed:", error);
  }
}

/**
 * Enforce "at most one open session per user" after the fact.
 *
 * The invariant is maintained by {@link openOrResumeWorkSession}; this exists
 * because that guarantee is a transaction rather than a database constraint,
 * and an invariant with no enforcement at rest is one bad day from being
 * untrue. Keeps the earliest open row — that is the shift that actually
 * started — and closes the rest at their own last heartbeat, so no wall-clock
 * time is counted twice.
 */
async function collapseDuplicateOpenSessions(): Promise<void> {
  const duplicates = await prisma.$queryRaw<{ id: string; started_at: Date; last_seen_at: Date }[]>(
    Prisma.sql`
      SELECT id, started_at, last_seen_at
      FROM (
        SELECT
          id,
          started_at,
          last_seen_at,
          row_number() OVER (PARTITION BY user_id ORDER BY started_at ASC, id ASC) AS rn
        FROM work_sessions
        WHERE ended_at IS NULL
      ) ranked
      WHERE rn > 1
    `,
  );

  for (const row of duplicates) {
    await closeSessionTx(prisma, row.id, row.started_at, row.last_seen_at, "superseded");
  }
}

/**
 * Write the end of a session, with the duration alongside it.
 *
 * One place, so `ended_at` and `duration_seconds` can never disagree — the
 * second is derived from the first and the row's own start, and is stored
 * because `SUM(duration_seconds)` over an indexed range is what the reports do
 * a great many times.
 *
 * `where: { endedAt: null }` on the update makes closing idempotent: two
 * closers racing (a logout and a sweep, say) cannot overwrite each other's
 * answer, because the second one matches no row.
 *
 * Never negative and never in the future: `endedAt` is floored at `startedAt`,
 * so a clock that stepped backwards produces a zero-length shift rather than a
 * negative one that would subtract from somebody's day.
 */
async function closeSessionTx(
  client: Pick<typeof prisma, "workSession">,
  id: string,
  startedAt: Date,
  rawEndedAt: Date,
  reason: string,
): Promise<void> {
  const endedAt = rawEndedAt < startedAt ? startedAt : rawEndedAt;
  const durationSeconds = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
  );

  await client.workSession.updateMany({
    where: { id, endedAt: null },
    data: { endedAt, durationSeconds, endedReason: reason },
  });
}
