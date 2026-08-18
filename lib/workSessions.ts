import { Prisma } from "./generated/prisma/client";
import { HEARTBEAT_SECONDS, type WorkClock } from "./performanceRules";
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
 * whose *liveness* has stopped for {@link STALE_MS} is *stale*, and is closed
 * at the instant it was last seen alive rather than at the moment somebody
 * noticed. A closed laptop therefore costs at most one grace window of
 * over-count, and never a clock that runs forever. Stale sessions are swept at
 * login (this app has no cron — see `pruneExpiredSessions` for the same
 * reasoning) and, so that a report is never wrong while waiting for someone to
 * sign in, are *also* clamped on read by {@link OPEN_SESSION_END_SQL}.
 *
 * **Logging out of one device while working on another.** Logout closes the
 * shift only when the person has no other live authentication session left
 * (see {@link endWorkSessionForLogout}). Signing out of a phone does not stop
 * the clock on the desk they are still sitting at.
 *
 * ---------------------------------------------------------------------------
 * Two liveness signals, and why there has to be more than one
 * ---------------------------------------------------------------------------
 * **Portal visibility is not the definition of working.** It used to be the
 * only thing this file measured, and that was a bug with teeth: an agent who
 * minimised the portal to work in Chrome, Excel or anything else stopped
 * beating, went stale five minutes later, and had their shift closed underneath
 * them — which in turn told the SpiderHunts Monitor to stop capturing
 * screenshots, activity and app usage on its next poll. The portal was
 * measuring "is this tab in front", and reporting it as "is this person at
 * work".
 *
 * So a shift now has two independent liveness signals, and stays open while
 * *either* is beating:
 *
 *   lastSeenAt         an open portal tab, once per {@link HEARTBEAT_SECONDS}.
 *                      Portal presence. Written by the browser heartbeat.
 *   lastMonitorSeenAt  an authenticated, unrevoked SpiderHunts Monitor device
 *                      belonging to this agent made a request while this shift
 *                      was open. Desktop-monitoring liveness. Written by
 *                      {@link touchMonitorLiveness}, from `getDeviceContext`.
 *
 * {@link livenessAt} is the one place the two are combined, and
 * {@link SESSION_LIVE_AT_SQL} is the same expression for the read path. Every
 * staleness decision in this file — resume, read, sweep, and the clamp the
 * reports apply — goes through one of those two and therefore cannot drift into
 * disagreeing.
 *
 * What this deliberately is **not**: a way to keep a shift alive on no signal
 * at all. A workstation whose Monitor has died and whose browser has gone quiet
 * is stale once {@link STALE_MS} has passed, and is closed at the last instant
 * either signal was seen — never at "now", so nothing is credited for the
 * silence. Both signals go quiet, the shift ends, and the Monitor is told it is
 * off the clock on its next poll.
 *
 * What this is also not: a way for the Monitor to *start* a shift.
 * {@link touchMonitorLiveness} can only update a row that is already open and
 * already live; it creates nothing and it cannot revive a shift that has
 * already gone stale. The portal still decides when work begins and ends.
 *
 * ---------------------------------------------------------------------------
 * Active time vs login time
 * ---------------------------------------------------------------------------
 * A duration here is *presence* — the portal or the workstation was in touch —
 * which is what was asked for. Real idle detection is a separate question and
 * already has its own answer: `activity_intervals` describes what happened
 * inside a shift, and `lib/timeTracking.ts` is careful never to let it redefine
 * the shift itself.
 */

/*
 * The heartbeat interval lives in `lib/performanceRules.ts` — the browser sets
 * its timer from it, so both ends agree on how often a live tab checks in. The
 * staleness window below is no longer derived from it and is stated outright;
 * see {@link STALE_MS} for why the two were separated. It is re-exported here
 * because this is the module the server side reads it from.
 */
export { HEARTBEAT_SECONDS };

/**
 * How long after the last signal of life a session is presumed dead.
 *
 * Thirty minutes, and **deliberately not a multiple of the heartbeat**. It was
 * five beats, which tied two unrelated questions to one number: how often a
 * live tab checks in, and how long a quiet one is given before its shift is
 * closed. Those want opposite things — the first wants to be frequent, so an
 * open tab is precisely tracked, and the second wants to be patient, so an
 * agent is not punished for looking away.
 *
 * Five minutes was far too impatient. A tab does not beat while it is hidden
 * (see the note in `WorkSessionProvider`), so an agent who switched to another
 * tab or minimised Chrome to work in another application went quiet, and five
 * minutes later the portal closed a shift they were in the middle of. For an
 * agent running the Monitor the desktop signal covers this; for one who is not,
 * nothing did, and this is the case that was actually breaking.
 *
 * Thirty minutes is long enough that ordinary work outside the browser — a
 * call, a spreadsheet, a lunch break with the lid down — never interrupts a
 * shift, and short enough that a crashed browser or a laptop taken home costs
 * half an hour of over-count rather than a night. The two failure modes are not
 * symmetric and this is not a midpoint: closing a live agent's shift is silent
 * and wrong in the record, while over-counting an abandoned one is visible,
 * bounded, and gets queried.
 *
 * The heartbeat itself is untouched at {@link HEARTBEAT_SECONDS}. A live tab
 * still checks in once a minute, so this window is the *tolerance for silence*
 * and never the resolution at which presence is measured.
 */
const STALE_MS = 30 * 60 * 1000;

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
 * The instant a session was last known to be alive, as SQL — the read path's
 * copy of {@link livenessAt}.
 *
 * `greatest(portal heartbeat, monitor heartbeat)`, with the monitor column
 * folded onto the portal one when it is null so `greatest` never sees a NULL
 * (in Postgres `greatest` ignores NULLs, but `coalesce` says so out loud and
 * survives somebody adding a third signal later). Every report that clamps an
 * open session reads this, so no figure anywhere in the portal can be built on
 * "the tab was in front" alone.
 *
 * Requires the sessions table to be aliased `ws`, as every caller already does.
 */
export const SESSION_LIVE_AT_SQL = Prisma.sql`greatest(ws.last_seen_at, coalesce(ws.last_monitor_seen_at, ws.last_seen_at))`;

/**
 * When an *open* session should be treated as having ended, as SQL.
 *
 * `least(now, last-seen-alive + grace)` — a live session ends "now" (its clock
 * is still running), and a dead one ended one grace window after the last
 * signal of any kind. This is what stops a browser that crashed an hour ago
 * from reporting an hour of work before anybody happens to sign in and trigger
 * the sweep.
 *
 * "Last signal of any kind" is the whole of this change on the read path: a
 * shift whose tab has been hidden for two hours while the Monitor kept
 * reporting is clamped to now, not to two hours ago, because
 * {@link SESSION_LIVE_AT_SQL} has seen the Monitor.
 *
 * Kept here, next to {@link STALE_MS}, so the read path and the write path
 * cannot drift apart into two different definitions of a dead session.
 */
export const OPEN_SESSION_END_SQL = Prisma.sql`least(${NOW_UTC_SQL}, ${SESSION_LIVE_AT_SQL} + interval '${Prisma.raw(String(STALE_MS / 1000))} seconds')`;

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

/** The two columns any staleness decision needs. Selected together, always. */
interface LivenessColumns {
  lastSeenAt: Date;
  lastMonitorSeenAt: Date | null;
}

/**
 * When this shift was last known to be alive — the later of the portal
 * heartbeat and the Monitor's, and the only definition of it in TypeScript.
 *
 * The counterpart of {@link SESSION_LIVE_AT_SQL}, kept beside it so the two
 * cannot say different things. Every `staleBefore` comparison and every
 * "close it at the last instant it was alive" in this file goes through here,
 * which is what makes "a hidden tab does not end a monitored shift" a property
 * of one function rather than of four call sites remembering to agree.
 *
 * Null `lastMonitorSeenAt` — a shift worked with no desktop client, and every
 * shift that existed before the column did — falls back to the portal
 * heartbeat, so the old behaviour is exactly preserved for those rows.
 */
function livenessAt(row: LivenessColumns): Date {
  const monitor = row.lastMonitorSeenAt;
  return monitor !== null && monitor > row.lastSeenAt ? monitor : row.lastSeenAt;
}

/** Is this shift still within the grace window on *either* signal? */
function isLive(row: LivenessColumns, staleBefore: Date): boolean {
  return livenessAt(row) > staleBefore;
}

/*
 * `WorkClock` — the shape the on-screen clock reads — lives in
 * `lib/performanceRules.ts` with the rest of the client-safe vocabulary,
 * because the provider that consumes it is a client component and this module
 * imports Prisma. Re-exported here so server callers name it from the module
 * that produces it.
 */
export type { WorkClock };

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
 * **Agents only.** An administrator gets no row and `null` back. Time tracking
 * exists to be reported on, and every report that sums this table is a report
 * about agents — so a shift opened for an administrator was write traffic and
 * storage for a figure that no screen drew and no total included. The check is
 * here, inside the one function that creates rows, rather than at its two call
 * sites (`completeSignIn` and the heartbeat), because a rule enforced at the
 * only `create` in the file cannot be forgotten by the third caller.
 *
 * The role is read from Postgres in the same transaction and never taken from
 * the caller, which is the same rule the rest of this file follows about ids.
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
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      // Not an agent — nothing to open, and nothing to close either: an
      // administrator has no open row for a later sweep to find. Rows written
      // before this rule existed are left alone; they close on their own
      // schedule and the reports below no longer list them.
      if (user?.role !== "AGENT") return null;

      const open = await tx.workSession.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: "asc" },
        select: { id: true, startedAt: true, lastSeenAt: true, lastMonitorSeenAt: true },
      });

      if (open && isLive(open, staleBefore)) {
        // Still beating on one signal or the other — this is the same shift,
        // and its id does not change. Touch it so a resume from a fresh browser
        // counts as presence straight away rather than waiting a minute for the
        // first heartbeat.
        await tx.workSession.update({
          where: { id: open.id },
          data: { lastSeenAt: now },
        });
        return { id: open.id, startedAt: open.startedAt.toISOString() };
      }

      if (open) {
        // Dead on both signals. Closed at the last instant *either* was seen,
        // so a Monitor that outlived the browser is still credited for the time
        // it was watching.
        await closeSessionTx(tx, open.id, open.startedAt, livenessAt(open), "timeout");
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
      select: { id: true, startedAt: true, lastSeenAt: true, lastMonitorSeenAt: true },
    })
    .catch(() => null);

  if (!open) return null;

  // A session that has stopped beating on *both* signals is not "the session
  // you are in" even though its row is still open — the sweep simply has not
  // reached it. Saying so here keeps the timer honest between a crash and the
  // next login. A hidden tab whose Monitor is still reporting is very much the
  // session you are in, and this is the read every part of the portal and the
  // Monitor's own status screen goes through, so they cannot disagree.
  if (!isLive(open, staleBefore)) return null;

  return { id: open.id, startedAt: open.startedAt.toISOString() };
}

/**
 * The on-screen clock: today's finished work, plus the shift still running.
 *
 * This is what makes signing out and back in stop looking like a reset. The
 * *current session* legitimately restarts at zero on a new login — that is what
 * a session is, and each one is its own permanent row — but the day's total
 * must not, and it does not, because it is a sum over every session that
 * started today rather than a property of the one in progress.
 *
 * Both halves are clamped to today, so a night shift that began yesterday
 * evening contributes only the part after midnight and the figure means
 * "worked today" rather than "worked since I last signed in".
 *
 * Two queries, deliberately not one:
 *
 *   - the completed sum is an aggregate over an indexed range and returns a
 *     single number;
 *   - the open session is a one-row lookup on `(user_id, ended_at)`.
 *
 * Combining them into a single statement would mean either an `OUTER JOIN`
 * against a one-row subquery or a `GROUPING SETS` — more SQL to read, no fewer
 * round trips worth counting, and a result shape that no longer says on its
 * face that the two halves do not overlap.
 */
export async function getWorkClock(userId: string): Promise<WorkClock> {
  const now = new Date();
  const todayStart = startOfToday();

  const [completed, active] = await Promise.all([
    // Closed sessions only — `ended_at IS NOT NULL`. This is the half of the
    // total that has stopped moving, and excluding the open one here is what
    // lets the client add the live figure without counting it twice.
    prisma
      .$queryRaw<{ seconds: number }[]>(Prisma.sql`
        SELECT coalesce(sum(${overlapSecondsSql(todayStart, now)}), 0)::int AS seconds
        FROM work_sessions ws
        WHERE ws.user_id = ${userId}
          AND ws.ended_at IS NOT NULL
          AND ws.started_at < ${utc(now)}
          AND ws.ended_at > ${utc(todayStart)}
      `)
      .catch(() => [{ seconds: 0 }]),
    getActiveWorkSession(userId),
  ]);

  return {
    startedAt: active?.startedAt ?? null,
    completedSecondsToday: completed[0]?.seconds ?? 0,
    serverNow: now.toISOString(),
    todayStart: todayStart.toISOString(),
  };
}

/**
 * Local midnight, on the server's clock.
 *
 * The same day boundary `todayIso()` and the reports use, so "today" means one
 * thing across the whole application — the figure in the top bar and the figure
 * on the admin report are the same day or the pair is untrustworthy.
 */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
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
 *
 * Returns the whole {@link WorkClock}, not just the session: the beat is
 * already a round trip, so it is also how the day's total and the server's own
 * clock are refreshed. Anything running long enough to drift is corrected once
 * a minute without a second request.
 */
export async function heartbeatWorkSession(userId: string): Promise<WorkClock> {
  const active = await getActiveWorkSession(userId);

  if (!active) {
    await openOrResumeWorkSession(userId);
  } else {
    await prisma.workSession
      .update({ where: { id: active.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {
        // Bookkeeping. A missed beat costs nothing: the next one lands, and the
        // grace window is thirty of them wide.
      });
  }

  // Read after writing, so the answer reflects the session this beat may have
  // just opened rather than the state from before it.
  return getWorkClock(userId);
}

/**
 * How long between two writes of `lastMonitorSeenAt` for the same shift.
 *
 * The Monitor makes several kinds of authenticated request — a status poll, an
 * activity interval, an app-usage segment, a screenshot — and every one of them
 * is a liveness signal, so without a throttle a busy workstation would rewrite
 * the same column many times a minute for no gain. One beat, matching the
 * portal's, is a thirtieth of the grace window and the same figure
 * `lib/monitorAuth.ts` already throttles `monitor_devices.last_seen_at` with.
 *
 * Left at one minute when the grace window grew to thirty: this is a *write*
 * throttle, and writing the column more often than the window needs costs
 * nothing while keeping the Monitor's liveness precise. Tying it to the window
 * would make a monitored shift's last-seen instant coarse by half an hour,
 * which is the figure a stale shift is then closed at.
 */
const MONITOR_TOUCH_AFTER_MS = HEARTBEAT_SECONDS * 1000;

/**
 * The Monitor's heartbeat: "this agent's workstation is still being watched".
 *
 * Called from `getDeviceContext` in `lib/monitorAuth.ts`, so **every**
 * authenticated Monitor request is a liveness signal and no new endpoint,
 * credential or client change is needed. By the time this runs the bearer token
 * has already resolved to an unrevoked device row, the account behind it has
 * been re-read from Postgres, and `checkMonitorEligibility` has confirmed it is
 * an enabled AGENT — so the `userId` here is derived from the credential and
 * never from anything the client sent.
 *
 * ---------------------------------------------------------------------------
 * The three things it deliberately cannot do
 * ---------------------------------------------------------------------------
 * **It cannot start a shift.** `updateMany` and no `create`, anywhere. A
 * workstation left running overnight against an agent who is signed out matches
 * no row and writes nothing, which is the property `lib/monitorAuth.ts` has
 * always promised and this change does not spend.
 *
 * **It cannot revive a dead one.** The `OR` on the two liveness columns means a
 * shift that is *already* stale is not matched. Without it, a Monitor coming
 * back after a two-hour outage would move the column to now and silently
 * un-close a shift that every report had already clamped — inventing two hours
 * of work and contradicting the figure the reports had been showing all
 * morning. It is refused, the sweep closes the shift at the instant it really
 * died, and the agent's next portal heartbeat opens a fresh one.
 *
 * **It cannot touch anybody else's shift.** `userId` is the device's owner, and
 * a device row *is* the credential — "does this device belong to this user"
 * cannot be false. One agent's Monitor keeping another agent's shift alive is
 * not defended against with a check, it is unrepresentable.
 *
 * Returns nothing and throws nothing. A missed touch costs a fraction of a
 * grace window that is thirty beats wide, and a monitoring request must never
 * fail because a bookkeeping write did.
 */
export async function touchMonitorLiveness(userId: string): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const touchBefore = new Date(now.getTime() - MONITOR_TOUCH_AFTER_MS);

  await prisma.workSession
    .updateMany({
      where: {
        userId,
        endedAt: null,
        // Still live on one signal or the other. `null` here is a shift that
        // has never seen a Monitor, which the portal heartbeat alone must be
        // keeping alive.
        OR: [
          { lastSeenAt: { gt: staleBefore } },
          { lastMonitorSeenAt: { gt: staleBefore } },
        ],
        // The throttle, ANDed with the above by Prisma. A shift whose column is
        // already within a beat of now has nothing to learn from this request.
        AND: [{ OR: [{ lastMonitorSeenAt: null }, { lastMonitorSeenAt: { lte: touchBefore } }] }],
      },
      // The server's clock, never the client's. A workstation with a doctored
      // system time cannot buy itself a longer shift, for the same reason it
      // cannot buy itself extra screenshot uploads.
      data: { lastMonitorSeenAt: now },
    })
    .catch(() => {
      // Bookkeeping. See the note above.
    });
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
 *
 * **A connected Monitor does not save the shift here, and must not.** Signing
 * out is an explicit statement that work has stopped, and it outranks every
 * liveness signal: `lastMonitorSeenAt` is not consulted, the row is closed at
 * `now`, and because everything that writes liveness matches only on
 * `endedAt: null`, no amount of Monitor traffic can reopen it. The Monitor is
 * told it is off the clock on its next poll, which is exactly the intended
 * behaviour. The same is true of an administrator's manual end and of a
 * revoked or disabled account — a revoked device cannot authenticate at all,
 * so it never reaches {@link touchMonitorLiveness}.
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
      select: { id: true, startedAt: true },
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
 * Housekeeping: close shifts that stopped talking on **both** signals, and
 * collapse any duplicate open row.
 *
 * Called opportunistically from the login route beside `pruneExpiredSessions`,
 * for the same reason given there — this app deploys as two short-lived
 * blue/green processes, so a background interval would be an unreliable place
 * to put it. Reports do not depend on it having run: {@link OPEN_SESSION_END_SQL}
 * clamps an un-swept session to the same instant this would have written.
 *
 * The `lastMonitorSeenAt` half of the predicate is what makes a dead Monitor
 * still cost a shift: silence from the desktop client is not special, it is
 * just the other signal going quiet, and once both have the shift is swept on
 * exactly the old schedule.
 */
export async function reconcileStaleWorkSessions(): Promise<void> {
  try {
    const staleBefore = new Date(Date.now() - STALE_MS);

    const stale = await prisma.workSession.findMany({
      where: {
        endedAt: null,
        lastSeenAt: { lte: staleBefore },
        // Null is "never seen by a Monitor" and cannot keep anything alive.
        // Both conditions are ANDed, so one live signal is enough to be spared.
        OR: [{ lastMonitorSeenAt: null }, { lastMonitorSeenAt: { lte: staleBefore } }],
      },
      select: { id: true, startedAt: true, lastSeenAt: true, lastMonitorSeenAt: true },
      // Bounded: a sweep is a courtesy on somebody's login request, not a job.
      // Whatever it misses is caught by the next one, and is correct on read
      // in the meantime.
      take: 200,
    });

    for (const session of stale) {
      // Closed at the later of the two, so a shift whose browser died at 09:15
      // and whose Monitor kept reporting until 11:00 is credited to 11:00.
      await closeSessionTx(prisma, session.id, session.startedAt, livenessAt(session), "timeout");
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
  const duplicates = await prisma.$queryRaw<{ id: string; started_at: Date; live_at: Date }[]>(
    Prisma.sql`
      SELECT id, started_at, live_at
      FROM (
        SELECT
          ws.id,
          ws.started_at,
          ${SESSION_LIVE_AT_SQL} AS live_at,
          row_number() OVER (PARTITION BY ws.user_id ORDER BY ws.started_at ASC, ws.id ASC) AS rn
        FROM work_sessions ws
        WHERE ws.ended_at IS NULL
      ) ranked
      WHERE rn > 1
    `,
  );

  for (const row of duplicates) {
    await closeSessionTx(prisma, row.id, row.started_at, row.live_at, "superseded");
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
