import type { Role } from "./access";
import { activityPolicy, inactivityThresholdSeconds } from "./activityPolicy";
import type {
  ActivityIntervalCard,
  EmployeeTimeRow,
  TeamTimePayload,
  TimeAdjustmentCard,
  TimesheetRow,
  TrackedSession,
} from "./activityRules";
import { Prisma } from "./generated/prisma/client";
import { addDays, type DateRange } from "./performanceRules";
import { prisma } from "./prisma";
import {
  NOW_UTC_SQL,
  OPEN_SESSION_END_SQL,
  overlapSecondsSql,
  utc,
} from "./workSessions";

/**
 * Time and activity reporting, counted by Postgres.
 *
 * The sibling of `lib/performance.ts`, written to the same rules: every figure
 * is a `sum`/`count` over an indexed range, nothing is assembled by reading rows
 * into the server and counting them in JavaScript, and nothing is sent to the
 * browser to be counted there. A month of activity for a team of twenty is
 * several hundred thousand interval rows and returns one row per agent.
 *
 * ---------------------------------------------------------------------------
 * The one definition everything here depends on
 * ---------------------------------------------------------------------------
 * **Tracked time comes from `work_sessions`. Active time comes from
 * `activity_intervals`. They are never the same query and the second is never
 * used to produce the first.**
 *
 * That is the requirement stated plainly, and it is also the only arrangement
 * that survives contact with reality: intervals arrive from a desktop client
 * that may be closed, uninstalled, offline or simply not yet reporting, so a
 * "total hours" figure summed from them would silently under-report an agent
 * who worked all day with the Monitor shut. The portal knows when somebody was
 * signed in and working; that is what a timesheet is made of. The intervals
 * describe what happened *inside* that time and can only ever be a subset of it.
 *
 * So, for any window:
 *
 *   tracked   = overlap of the window with the agent's work sessions
 *   active    = duration of the intervals in the window that had at least one
 *               keyboard or mouse event
 *   idle      = tracked − active
 *
 * `idle` therefore includes time no interval covered at all — a stretch when
 * the Monitor was not running reads as idle, not as absent. That is the honest
 * reading: the portal cannot claim input it never observed. It also means idle
 * can never go negative, because active is bounded by the intervals inside the
 * sessions that tracked is summed from.
 *
 * ---------------------------------------------------------------------------
 * "Active" here is not `AgentPerformance.activeSeconds`
 * ---------------------------------------------------------------------------
 * A genuine naming collision with `lib/performanceRules.ts`, called out because
 * it would otherwise be found the hard way. There, `activeSeconds` means
 * *seconds signed in* — it predates activity tracking and is what the
 * performance reports have always meant by active. Here, active means *seconds
 * with input observed*, and the signed-in figure is called `trackedSeconds`.
 * Neither name is changed: renaming the older one would touch every performance
 * screen and endpoint for a cosmetic gain, and the two live in separate modules
 * with separate payload types that never meet in one response.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not in this file
 * ---------------------------------------------------------------------------
 * Deliberately, and for the reason `lib/performance.ts` and
 * `lib/screenshotViewer.ts` both give: the policy lives at the door. The agent
 * endpoint passes the session user's own id and takes none from the request;
 * every admin endpoint is behind `apiAdmin()`. A `userId` argument below is a
 * *filter*, never a permission.
 */

/*
 * `NOW_UTC_SQL`, `utc()`, `overlapSecondsSql` and `OPEN_SESSION_END_SQL` come
 * from `lib/workSessions.ts`. Every timestamp comparison goes through them,
 * because these columns hold naive UTC and Postgres's own `now()` does not —
 * see the long note there. Reusing them rather than restating them is what
 * keeps a report and the agent's own clock from disagreeing about when a stale
 * session ended.
 */

/** An interval is "active" when it saw at least one event of either kind. */
const HAD_INPUT = Prisma.sql`(ai.keyboard_activity_count + ai.mouse_activity_count) > 0`;

/**
 * The duration-weighted mean activity percentage, as SQL.
 *
 * Weighted by duration for the reason `weightedActivity` gives: intervals are
 * not all the same length, and an unweighted mean would let a 10-second one
 * count as much as a full minute. Null — not zero — when there is nothing to
 * average, so "never tracked" and "tracked and idle" stay distinguishable all
 * the way to the screen.
 */
const WEIGHTED_ACTIVITY_SQL = Prisma.sql`
  round(
    sum(ai.activity_percentage * ai.duration_seconds)::numeric
    / nullif(sum(ai.duration_seconds), 0)
  )::int
`;

/**
 * Seconds of a work session inside a window given as SQL rather than as Dates.
 *
 * The same expression `overlapSecondsSql` builds, for the timesheet's
 * day-by-day join where the bounds are columns from a generated series instead
 * of literals. Kept next to its sibling's import so the two definitions of "how
 * much of this shift falls in this window" can be compared at a glance.
 */
function overlapSecondsBetween(from: Prisma.Sql, to: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    greatest(
      0,
      extract(epoch FROM (
        least(coalesce(ws.ended_at, ${OPEN_SESSION_END_SQL}), ${to})
        - greatest(ws.started_at, ${from})
      ))
    )
  `;
}

/* -------------------------------------------------------------------------- */
/* Shared aggregates                                                          */
/* -------------------------------------------------------------------------- */

interface IntervalTotals {
  observedSeconds: number;
  activeSeconds: number;
  activityPercentage: number | null;
  lastActivityAt: string | null;
}

const ZERO_INTERVALS: IntervalTotals = {
  observedSeconds: 0,
  activeSeconds: 0,
  activityPercentage: null,
  lastActivityAt: null,
};

/**
 * Interval totals per agent and for everybody, over one window.
 *
 * `GROUPING SETS ((user_id), ())` for the same reason `activityAggregate` uses
 * it: the per-agent rows and the team row come from a single pass. The team row
 * is a plain sum here — two agents active in the same hour is genuinely two
 * agent-hours of input — and its percentage is the weighted mean across
 * everybody, which is what "average activity" on a dashboard means.
 *
 * Intervals are selected by `started_at` falling in the window rather than by
 * overlapping it. An interval is at most a couple of minutes long, so the
 * boundary effect is bounded by that and never accumulates; the alternative —
 * splitting an interval across two windows — would mean apportioning event
 * counts that were only ever observed in aggregate, which is inventing data to
 * avoid a two-minute edge.
 */
async function intervalTotals(
  from: Date,
  to: Date,
  userId: string | null,
): Promise<Map<string | null, IntervalTotals>> {
  const scope = userId ? Prisma.sql`AND ai.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<
    {
      user_id: string | null;
      observed_seconds: number;
      active_seconds: number;
      activity_percentage: number | null;
      last_activity_at: Date | null;
    }[]
  >(Prisma.sql`
    SELECT
      ai.user_id,
      coalesce(sum(ai.duration_seconds), 0)::int                          AS observed_seconds,
      coalesce(sum(ai.duration_seconds) FILTER (WHERE ${HAD_INPUT}), 0)::int AS active_seconds,
      ${WEIGHTED_ACTIVITY_SQL}                                            AS activity_percentage,
      max(ai.ended_at)                                                    AS last_activity_at
    FROM activity_intervals ai
    WHERE ai.started_at >= ${utc(from)} AND ai.started_at < ${utc(to)}
    ${scope}
    GROUP BY GROUPING SETS ((ai.user_id), ())
  `);

  return new Map(
    rows.map((row) => [
      row.user_id,
      {
        observedSeconds: row.observed_seconds,
        activeSeconds: row.active_seconds,
        activityPercentage: row.activity_percentage,
        lastActivityAt: row.last_activity_at?.toISOString() ?? null,
      },
    ]),
  );
}

/** Tracked (signed-in) seconds per agent and for everybody, over one window. */
async function trackedSeconds(
  from: Date,
  to: Date,
  userId: string | null,
): Promise<Map<string | null, number>> {
  const scope = userId ? Prisma.sql`AND ws.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ user_id: string | null; seconds: number }[]>(
    Prisma.sql`
      SELECT
        ws.user_id,
        coalesce(sum(${overlapSecondsSql(from, to)}), 0)::int AS seconds
      FROM work_sessions ws
      WHERE ws.started_at < ${utc(to)}
        AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > ${utc(from)}
      ${scope}
      GROUP BY GROUPING SETS ((ws.user_id), ())
    `,
  );

  return new Map(rows.map((row) => [row.user_id, row.seconds]));
}

/* -------------------------------------------------------------------------- */
/* The agent's own screen                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything on `/time-tracking`, for one person and nobody else.
 *
 * The `userId` argument is the session user's id, passed by the page and the
 * endpoint and taken from neither's request — the same construction
 * `personalPerformanceSummary` uses, and the reason there is no URL or parameter
 * that turns this into a colleague's screen.
 *
 * **No screenshot images and no screenshot ids.** Only a count and the capture
 * times, because `lib/access.ts` is explicit that no agent may see any
 * screenshot including their own, and a monitoring feature whose subject can
 * read it back is a different feature. The count is what makes monitoring
 * visible to the person being monitored, which is the part they are entitled to.
 */
export interface AgentTimeTracking {
  /** Null when no shift is running. The client counts up from it. */
  currentSessionStartedAt: string | null;
  /** True when input has been seen inside the idle threshold. */
  working: boolean;
  todaySeconds: number;
  todayActiveSeconds: number;
  todayIdleSeconds: number;
  weekSeconds: number;
  weekActiveSeconds: number;
  /** Today's duration-weighted mean, or null when nothing was observed. */
  activityPercentage: number | null;
  lastActivityAt: string | null;
  sessions: TrackedSession[];
  intervals: ActivityIntervalCard[];
  /** Captures during today's shifts. Times only — never ids, never images. */
  screenshots: { count: number; latestCapturedAt: string | null };
  /** So the screen can explain the numbers it is showing. */
  policy: { intervalSeconds: number; idleThresholdSeconds: number };
  /** The instant every figure above was read at. */
  asOf: string;
}

export async function agentTimeTracking(
  userId: string,
  today: DateRange,
  week: DateRange,
): Promise<AgentTimeTracking> {
  const now = new Date();
  const idleThreshold = inactivityThresholdSeconds();

  const [todayIntervals, weekIntervals, todayTracked, weekTracked, sessions, intervals, shots, open] =
    await Promise.all([
      intervalTotals(today.from, today.to, userId),
      intervalTotals(week.from, week.to, userId),
      trackedSeconds(today.from, today.to, userId),
      trackedSeconds(week.from, week.to, userId),
      recentSessions(userId, week.from, week.to),
      recentIntervals(userId, 40),
      prisma.screenshot.aggregate({
        where: { userId, capturedAt: { gte: today.from, lt: today.to } },
        _count: { _all: true },
        _max: { capturedAt: true },
      }),
      prisma.workSession.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: "asc" },
        select: { startedAt: true },
      }),
    ]);

  const todayTotals = todayIntervals.get(userId) ?? ZERO_INTERVALS;
  const weekTotals = weekIntervals.get(userId) ?? ZERO_INTERVALS;
  const todaySeconds = todayTracked.get(userId) ?? 0;

  return {
    currentSessionStartedAt: open?.startedAt.toISOString() ?? null,
    working: isWorking(open !== null, todayTotals.lastActivityAt, now, idleThreshold),
    todaySeconds,
    todayActiveSeconds: todayTotals.activeSeconds,
    // Floored at zero. It cannot go negative by construction — active is a
    // subset of tracked — but a floor is cheaper than trusting that forever.
    todayIdleSeconds: Math.max(0, todaySeconds - todayTotals.activeSeconds),
    weekSeconds: weekTracked.get(userId) ?? 0,
    weekActiveSeconds: weekTotals.activeSeconds,
    activityPercentage: todayTotals.activityPercentage,
    lastActivityAt: todayTotals.lastActivityAt,
    sessions,
    intervals,
    screenshots: {
      count: shots._count._all,
      latestCapturedAt: shots._max.capturedAt?.toISOString() ?? null,
    },
    policy: { intervalSeconds: activityPolicy().intervalSeconds, idleThresholdSeconds: idleThreshold },
    asOf: now.toISOString(),
  };
}

/**
 * Is this person working *right now*?
 *
 * Two conditions, and both are required. The shift must be open — the portal's
 * own view of "on the clock", which nothing in activity tracking may override —
 * and input must have been observed inside the idle threshold.
 *
 * An agent with no Monitor connected is therefore online and not working, which
 * is correct: the portal has no evidence of input and will not invent any. The
 * dashboard says "no activity data" for that case rather than "inactive", so
 * nobody reads a missing desktop client as an idle employee.
 */
function isWorking(
  online: boolean,
  lastActivityAt: string | null,
  now: Date,
  idleThresholdSeconds: number,
): boolean {
  if (!online || !lastActivityAt) return false;
  return now.getTime() - new Date(lastActivityAt).getTime() <= idleThresholdSeconds * 1000;
}

/**
 * One person's shifts over a window, with the activity inside each.
 *
 * One statement rather than a query per session: the intervals and the
 * screenshots are joined as correlated aggregates, so twenty shifts cost one
 * round trip. Bounded by `take` — this is a "recent" list on a screen, not an
 * export.
 */
async function recentSessions(
  userId: string,
  from: Date,
  to: Date,
  limit = 20,
): Promise<TrackedSession[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      started_at: Date;
      ended_at: Date | null;
      tracked_seconds: number;
      active_seconds: number;
      activity_percentage: number | null;
      screenshot_count: number;
      adjusted: boolean;
    }[]
  >(Prisma.sql`
    SELECT
      ws.id,
      ws.started_at,
      ws.ended_at,
      ${overlapSecondsSql(from, to)}::int AS tracked_seconds,
      coalesce(activity.active_seconds, 0)::int AS active_seconds,
      activity.activity_percentage,
      coalesce(shots.count, 0)::int AS screenshot_count,
      coalesce(adjusted.count, 0) > 0 AS adjusted
    FROM work_sessions ws
    LEFT JOIN LATERAL (
      SELECT
        sum(ai.duration_seconds) FILTER (WHERE ${HAD_INPUT})::int AS active_seconds,
        ${WEIGHTED_ACTIVITY_SQL} AS activity_percentage
      FROM activity_intervals ai
      WHERE ai.work_session_id = ws.id
    ) activity ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS count FROM screenshots s WHERE s.work_session_id = ws.id
    ) shots ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS count FROM time_adjustments ta WHERE ta.work_session_id = ws.id
    ) adjusted ON true
    WHERE ws.user_id = ${userId}
      AND ws.started_at < ${utc(to)}
      AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > ${utc(from)}
    ORDER BY ws.started_at DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    trackedSeconds: row.tracked_seconds,
    activeSeconds: row.active_seconds,
    idleSeconds: Math.max(0, row.tracked_seconds - row.active_seconds),
    activityPercentage: row.activity_percentage,
    screenshotCount: row.screenshot_count,
    adjusted: row.adjusted,
  }));
}

/** The newest intervals for one person. A list to read, so it is bounded. */
async function recentIntervals(
  userId: string,
  limit: number,
  workSessionId?: string,
): Promise<ActivityIntervalCard[]> {
  const rows = await prisma.activityInterval.findMany({
    where: { userId, ...(workSessionId ? { workSessionId } : {}) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      durationSeconds: true,
      keyboardActivityCount: true,
      mouseActivityCount: true,
      activityPercentage: true,
      // Never `clientKey`. It is a write-side retry token with no meaning to a
      // reader, and a column not selected cannot be leaked by a careless
      // serialisation — the same discipline `screenshotViewer` applies to
      // `storageKey`.
    },
  });

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    durationSeconds: row.durationSeconds,
    keyboardActivityCount: row.keyboardActivityCount,
    mouseActivityCount: row.mouseActivityCount,
    activityPercentage: row.activityPercentage,
  }));
}

/* -------------------------------------------------------------------------- */
/* The admin dashboard                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every employee's current state and today's/this week's figures.
 *
 * Every account is listed, including the ones who have not signed in today —
 * an employee with no hours is the most useful row on a monitoring dashboard,
 * and dropping them for having no sessions would hide exactly that. Same
 * decision `teamPerformance` and `agentWorkTime` already made.
 *
 * Six aggregates, issued concurrently, each one row per agent. Nothing here
 * scales with the number of intervals or screenshots in the window.
 */
export async function teamTimeTracking(
  today: DateRange,
  week: DateRange,
): Promise<TeamTimePayload> {
  const now = new Date();
  const policy = activityPolicy();

  const [users, todayIntervals, todayTracked, weekTracked, openSessions] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, name: true, username: true, role: true, isActive: true },
      orderBy: [{ name: "asc" }],
    }),
    intervalTotals(today.from, today.to, null),
    trackedSeconds(today.from, today.to, null),
    trackedSeconds(week.from, week.to, null),
    prisma.workSession.findMany({
      where: { endedAt: null },
      select: { userId: true, startedAt: true },
      orderBy: { startedAt: "asc" },
    }),
  ]);

  // The one-open-session invariant means at most one per user; taking the
  // first is the earliest, which is the shift that actually started (the same
  // choice `collapseDuplicateOpenSessions` makes).
  const open = new Map<string, Date>();
  for (const row of openSessions) {
    if (!open.has(row.userId)) open.set(row.userId, row.startedAt);
  }

  const employees: EmployeeTimeRow[] = users.map((user) => {
    const totals = todayIntervals.get(user.id) ?? ZERO_INTERVALS;
    const startedAt = open.get(user.id) ?? null;

    return {
      userId: user.id,
      name: user.name,
      username: user.username,
      role: user.role as Role,
      isActive: user.isActive,
      online: startedAt !== null,
      working: isWorking(
        startedAt !== null,
        totals.lastActivityAt,
        now,
        policy.idleThresholdSeconds,
      ),
      todaySeconds: todayTracked.get(user.id) ?? 0,
      weekSeconds: weekTracked.get(user.id) ?? 0,
      activityPercentage: totals.activityPercentage,
      lastActivityAt: totals.lastActivityAt,
      currentSessionStartedAt: startedAt?.toISOString() ?? null,
    };
  });

  const teamTotals = todayIntervals.get(null) ?? ZERO_INTERVALS;

  return {
    summary: {
      totalEmployees: employees.length,
      currentlyWorking: employees.filter((row) => row.working).length,
      // Online but without recent input. Deliberately not "everyone who is not
      // working": somebody who is signed out is off the clock, not inactive,
      // and counting them here would make the two figures add up to the whole
      // company every night.
      currentlyInactive: employees.filter((row) => row.online && !row.working).length,
      todaySeconds: todayTracked.get(null) ?? 0,
      weekSeconds: weekTracked.get(null) ?? 0,
      averageActivityPercentage: teamTotals.activityPercentage,
      asOf: now.toISOString(),
    },
    employees,
    policy,
  };
}

/* -------------------------------------------------------------------------- */
/* One employee, in detail                                                    */
/* -------------------------------------------------------------------------- */

export interface EmployeeTimeDetail {
  user: { id: string; name: string; username: string; role: Role; isActive: boolean };
  range: { from: string; to: string; label: string };
  trackedSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  activityPercentage: number | null;
  sessions: TrackedSession[];
  intervals: ActivityIntervalCard[];
  /** Meetings booked and completed in the window, from the existing log. */
  meetings: { booked: number; completed: number; callsLogged: number };
  screenshots: { count: number; latestCapturedAt: string | null };
  adjustments: TimeAdjustmentCard[];
  asOf: string;
}

/**
 * One agent's tracking record over a window. ADMIN only, enforced at the route.
 *
 * The meeting figures come from `lead_activities` — the existing log of what an
 * agent did to a lead — and not from a second activity system invented for time
 * tracking. Where the existing data supports a figure it is counted; where it
 * does not, the figure is absent rather than approximated.
 */
export async function employeeTimeDetail(
  userId: string,
  range: DateRange,
): Promise<EmployeeTimeDetail | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, username: true, role: true, isActive: true },
  });
  if (!user) return null;

  const now = new Date();

  const [intervals, tracked, sessions, recent, leadWork, shots, adjustments] = await Promise.all([
    intervalTotals(range.from, range.to, userId),
    trackedSeconds(range.from, range.to, userId),
    recentSessions(userId, range.from, range.to, 100),
    recentIntervals(userId, 100),
    prisma.$queryRaw<{ booked: number; completed: number; calls: number }[]>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE a.kind = 'meeting_booked')::int    AS booked,
        count(*) FILTER (WHERE a.kind = 'meeting_completed')::int AS completed,
        count(*) FILTER (WHERE a.kind = 'call_logged')::int       AS calls
      FROM lead_activities a
      WHERE a.user_id = ${userId}
        AND a.created_at >= ${utc(range.from)} AND a.created_at < ${utc(range.to)}
    `),
    prisma.screenshot.aggregate({
      where: { userId, capturedAt: { gte: range.from, lt: range.to } },
      _count: { _all: true },
      _max: { capturedAt: true },
    }),
    listAdjustments({ userId, limit: 25 }),
  ]);

  const totals = intervals.get(userId) ?? ZERO_INTERVALS;
  const trackedTotal = tracked.get(userId) ?? 0;

  return {
    user: { ...user, role: user.role as Role },
    range: { from: range.fromDay, to: range.toDay, label: range.label },
    trackedSeconds: trackedTotal,
    activeSeconds: totals.activeSeconds,
    idleSeconds: Math.max(0, trackedTotal - totals.activeSeconds),
    activityPercentage: totals.activityPercentage,
    sessions,
    intervals: recent,
    meetings: {
      booked: leadWork[0]?.booked ?? 0,
      completed: leadWork[0]?.completed ?? 0,
      callsLogged: leadWork[0]?.calls ?? 0,
    },
    screenshots: {
      count: shots._count._all,
      latestCapturedAt: shots._max.capturedAt?.toISOString() ?? null,
    },
    adjustments,
    asOf: now.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Timesheets                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One row per employee per day: first in, last out, and how the time split.
 *
 * **A generated day series, joined to the sessions.** The obvious alternative —
 * `GROUP BY date(started_at)` — is wrong for a shift that crosses midnight: it
 * files the whole night under the day it began, so an agent who worked 22:00 to
 * 02:00 gets four hours on Monday and none on Tuesday, and the daily totals
 * stop adding up to the weekly one. Joining each day to the sessions that
 * overlap it and clamping with the same expression every other figure in the
 * app uses means a shift contributes to each day exactly the part that fell in
 * it.
 *
 * Days with no work are dropped rather than emitted empty: a timesheet listing
 * every employee against every weekend is a page of zeroes to scroll past. The
 * report above it carries the totals, so nothing is lost by their absence.
 *
 * Bounded by the range, which the route caps — see `resolveTimesheetRange`.
 */
export async function timesheet(
  range: DateRange,
  userId: string | null = null,
): Promise<TimesheetRow[]> {
  const scope = userId ? Prisma.sql`AND ws.user_id = ${userId}` : Prisma.empty;
  const intervalScope = userId ? Prisma.sql`AND ai.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<
    {
      user_id: string;
      name: string;
      day_index: number;
      first_started_at: Date | null;
      last_ended_at: Date | null;
      has_open: boolean;
      tracked_seconds: number;
      active_seconds: number;
      activity_percentage: number | null;
      sessions: number;
    }[]
  >(Prisma.sql`
    WITH days AS (
      /*
       * One row per local day in the range, as the naive-UTC instant that local
       * midnight actually is (see the note on utc() in lib/workSessions.ts).
       *
       * The ordinal matters as much as the instant. Labelling a day with
       * to_char(day_start) would print the UTC date of a local-midnight
       * boundary, which east of Greenwich is the *previous* day -- a shift
       * worked at 1pm on the 12th would appear on the timesheet under the 11th.
       * So the day is identified by its position in the series and the label is
       * derived in TypeScript from range.fromDay, which is exact across a
       * daylight-saving change rather than approximately right.
       */
      SELECT
        day_start,
        (row_number() OVER (ORDER BY day_start))::int - 1 AS day_index
      FROM generate_series(
        ${utc(range.from)},
        ${utc(range.to)} - interval '1 day',
        interval '1 day'
      ) AS day_start
    ),
    -- Work sessions clamped into each day. This is the timesheet proper: every
    -- figure below comes from work_sessions, never from activity.
    worked AS (
      SELECT
        ws.user_id,
        d.day_start,
        d.day_index,
        sum(${overlapSecondsBetween(
          Prisma.sql`d.day_start`,
          Prisma.sql`d.day_start + interval '1 day'`,
        )})::int                                            AS tracked_seconds,
        -- Clamped into the day, so a shift that began the previous evening
        -- reads as starting at midnight on this one rather than reporting
        -- yesterday's time as today's first punch.
        min(greatest(ws.started_at, d.day_start))           AS first_started_at,
        max(ws.ended_at) FILTER (WHERE ws.ended_at IS NOT NULL) AS last_ended_at,
        bool_or(ws.ended_at IS NULL)                        AS has_open,
        count(DISTINCT ws.id)::int                          AS sessions
      FROM days d
      JOIN work_sessions ws
        ON ws.started_at < d.day_start + interval '1 day'
       AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > d.day_start
      ${scope}
      GROUP BY 1, 2, 3
    ),
    -- Activity, bucketed by the day an interval started in. Separate CTE, and
    -- LEFT JOINed below: a day with sessions and no intervals is a real day
    -- with no activity data, and must not vanish from the timesheet.
    observed AS (
      SELECT
        ai.user_id,
        d.day_start,
        sum(ai.duration_seconds) FILTER (WHERE ${HAD_INPUT})::int AS active_seconds,
        ${WEIGHTED_ACTIVITY_SQL}                                  AS activity_percentage
      FROM days d
      JOIN activity_intervals ai
        ON ai.started_at >= d.day_start
       AND ai.started_at < d.day_start + interval '1 day'
      ${intervalScope}
      GROUP BY 1, 2
    )
    SELECT
      w.user_id,
      u.name,
      w.day_index,
      w.first_started_at,
      w.last_ended_at,
      w.has_open,
      w.tracked_seconds,
      coalesce(o.active_seconds, 0)::int          AS active_seconds,
      o.activity_percentage,
      w.sessions
    FROM worked w
    JOIN users u ON u.id = w.user_id
    LEFT JOIN observed o ON o.user_id = w.user_id AND o.day_start = w.day_start
    WHERE w.tracked_seconds > 0
    ORDER BY w.day_start DESC, u.name ASC
  `);

  return rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    // The label, from the ordinal. See the note in the `days` CTE.
    day: addDays(range.fromDay, row.day_index),
    firstStartedAt: row.first_started_at?.toISOString() ?? null,
    // An open shift has no end, and writing one would be inventing it. The
    // screen renders null as "still open" rather than as a missing value.
    lastEndedAt: row.has_open ? null : (row.last_ended_at?.toISOString() ?? null),
    trackedSeconds: row.tracked_seconds,
    activeSeconds: row.active_seconds,
    idleSeconds: Math.max(0, row.tracked_seconds - row.active_seconds),
    activityPercentage: row.activity_percentage,
    sessions: row.sessions,
  }));
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

export interface TimeReportRow {
  userId: string;
  name: string;
  username: string;
  role: Role;
  online: boolean;
  trackedSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  activityPercentage: number | null;
  sessions: number;
  meetingsBooked: number;
  meetingsCompleted: number;
  screenshots: number;
}

export interface TimeReport {
  range: { from: string; to: string; label: string };
  rows: TimeReportRow[];
  totals: {
    trackedSeconds: number;
    activeSeconds: number;
    idleSeconds: number;
    activityPercentage: number | null;
    sessions: number;
    meetingsBooked: number;
    meetingsCompleted: number;
    screenshots: number;
  };
  asOf: string;
}

export interface TimeReportFilters {
  userId: string | null;
  /** Keep only agents whose activity percentage is at or above this. */
  minActivity: number | null;
  /** `working`, `inactive`, `offline`, or null for everybody. */
  status: "working" | "inactive" | "offline" | null;
}

/**
 * The admin report: totals per employee over a window, with filters.
 *
 * Six aggregates and a user list, all server-side, all one row per agent. The
 * requirement that thousands of activity rows must never reach the browser is
 * satisfied structurally: there is no query in this function that returns a row
 * per interval, so there is nothing to accidentally send.
 *
 * The filters are applied *after* aggregation, in JavaScript, over at most one
 * row per employee. That is deliberate rather than lazy: `minActivity` and
 * `status` are predicates on computed values (a weighted mean, and a comparison
 * of two clocks), so pushing them into SQL would mean a `HAVING` on one and a
 * correlated subquery on the other for a list that is tens of rows long. The
 * expensive part — the scan over intervals and sessions — is already narrowed
 * by the date range and the optional agent, which *are* in SQL.
 */
export async function timeReport(
  range: DateRange,
  filters: TimeReportFilters,
): Promise<TimeReport> {
  const now = new Date();
  const idleThreshold = inactivityThresholdSeconds();
  const scope = filters.userId;

  const [users, intervals, tracked, sessionCounts, leadWork, shots, openSessions] =
    await Promise.all([
      prisma.user.findMany({
        where: scope ? { id: scope } : {},
        select: { id: true, name: true, username: true, role: true },
        orderBy: [{ name: "asc" }],
      }),
      intervalTotals(range.from, range.to, scope),
      trackedSeconds(range.from, range.to, scope),
      prisma.$queryRaw<{ user_id: string; sessions: number }[]>(Prisma.sql`
        SELECT ws.user_id, count(*)::int AS sessions
        FROM work_sessions ws
        WHERE ws.started_at < ${utc(range.to)}
          AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > ${utc(range.from)}
          ${scope ? Prisma.sql`AND ws.user_id = ${scope}` : Prisma.empty}
        GROUP BY ws.user_id
      `),
      prisma.$queryRaw<{ user_id: string; booked: number; completed: number }[]>(Prisma.sql`
        SELECT
          a.user_id,
          count(*) FILTER (WHERE a.kind = 'meeting_booked')::int    AS booked,
          count(*) FILTER (WHERE a.kind = 'meeting_completed')::int AS completed
        FROM lead_activities a
        WHERE a.created_at >= ${utc(range.from)} AND a.created_at < ${utc(range.to)}
          ${scope ? Prisma.sql`AND a.user_id = ${scope}` : Prisma.empty}
        GROUP BY a.user_id
      `),
      prisma.$queryRaw<{ user_id: string; count: number }[]>(Prisma.sql`
        SELECT s.user_id, count(*)::int AS count
        FROM screenshots s
        WHERE s.captured_at >= ${utc(range.from)} AND s.captured_at < ${utc(range.to)}
          ${scope ? Prisma.sql`AND s.user_id = ${scope}` : Prisma.empty}
        GROUP BY s.user_id
      `),
      prisma.workSession.findMany({
        where: { endedAt: null, ...(scope ? { userId: scope } : {}) },
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);

  const sessionsBy = new Map(sessionCounts.map((row) => [row.user_id, row.sessions]));
  const meetingsBy = new Map(leadWork.map((row) => [row.user_id, row]));
  const shotsBy = new Map(shots.map((row) => [row.user_id, row.count]));
  const online = new Set(openSessions.map((row) => row.userId));

  let rows: TimeReportRow[] = users.map((user) => {
    const totals = intervals.get(user.id) ?? ZERO_INTERVALS;
    const trackedTotal = tracked.get(user.id) ?? 0;
    const meetings = meetingsBy.get(user.id);

    return {
      userId: user.id,
      name: user.name,
      username: user.username,
      role: user.role as Role,
      online: online.has(user.id),
      trackedSeconds: trackedTotal,
      activeSeconds: totals.activeSeconds,
      idleSeconds: Math.max(0, trackedTotal - totals.activeSeconds),
      activityPercentage: totals.activityPercentage,
      sessions: sessionsBy.get(user.id) ?? 0,
      meetingsBooked: meetings?.booked ?? 0,
      meetingsCompleted: meetings?.completed ?? 0,
      screenshots: shotsBy.get(user.id) ?? 0,
    };
  });

  if (filters.minActivity !== null) {
    const floor = filters.minActivity;
    // An agent with no activity data is excluded by an activity floor above
    // zero. `null` is "not observed", and treating it as 0 would report a whole
    // team without the Monitor installed as failing an activity threshold.
    rows = rows.filter((row) => row.activityPercentage !== null && row.activityPercentage >= floor);
  }

  if (filters.status !== null) {
    const status = filters.status;
    rows = rows.filter((row) => {
      const lastActivityAt = intervals.get(row.userId)?.lastActivityAt ?? null;
      const working = isWorking(row.online, lastActivityAt, now, idleThreshold);
      if (status === "working") return working;
      if (status === "inactive") return row.online && !working;
      return !row.online;
    });
  }

  const totals = rows.reduce(
    (sum, row) => ({
      trackedSeconds: sum.trackedSeconds + row.trackedSeconds,
      activeSeconds: sum.activeSeconds + row.activeSeconds,
      idleSeconds: sum.idleSeconds + row.idleSeconds,
      sessions: sum.sessions + row.sessions,
      meetingsBooked: sum.meetingsBooked + row.meetingsBooked,
      meetingsCompleted: sum.meetingsCompleted + row.meetingsCompleted,
      screenshots: sum.screenshots + row.screenshots,
    }),
    {
      trackedSeconds: 0,
      activeSeconds: 0,
      idleSeconds: 0,
      sessions: 0,
      meetingsBooked: 0,
      meetingsCompleted: 0,
      screenshots: 0,
    },
  );

  return {
    range: { from: range.fromDay, to: range.toDay, label: range.label },
    rows,
    totals: {
      ...totals,
      /*
       * Straight from the aggregate when nothing was filtered out, so it is the
       * true interval-duration-weighted mean rather than a mean of means.
       *
       * With a filter applied that aggregate describes the wrong population, so
       * it is recomputed over the surviving rows — weighted by tracked time,
       * because that is the only weight a row carries. The two weightings agree
       * whenever intervals cover tracked time evenly and diverge slightly when
       * they do not; the alternative was a second round trip to re-aggregate
       * intervals for a filtered set of ids, for a figure whose whole job is to
       * be a summary of the rows on screen.
       */
      activityPercentage:
        filters.minActivity === null && filters.status === null
          ? (intervals.get(null)?.activityPercentage ?? null)
          : weightedOverRows(rows),
    },
    asOf: now.toISOString(),
  };
}

/** The weighted mean across report rows, weighted by tracked time. */
function weightedOverRows(rows: readonly TimeReportRow[]): number | null {
  let weighted = 0;
  let total = 0;

  for (const row of rows) {
    if (row.activityPercentage === null) continue;
    weighted += row.activityPercentage * row.trackedSeconds;
    total += row.trackedSeconds;
  }

  return total === 0 ? null : Math.round(weighted / total);
}

/* -------------------------------------------------------------------------- */
/* Manual corrections                                                         */
/* -------------------------------------------------------------------------- */

/** An expected refusal from a correction, with the status the route answers. */
export class AdjustmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The longest a corrected shift may be. A day is already a generous shift. */
const MAX_SESSION_SECONDS = 24 * 60 * 60;

export interface AdjustmentInput {
  workSessionId: string;
  /** ISO instants. Omit either to leave it as it is. */
  startedAt?: string | null;
  endedAt?: string | null;
  reason: string;
}

/**
 * Correct a work session, and record that it was corrected.
 *
 * **Both halves in one transaction.** A corrected session with no audit row is
 * exactly the "silent overwrite" the requirement forbids, and it is what a
 * crash between two separate statements would produce. Inside a transaction the
 * pair is atomic: either the shift moved and the record says who moved it, or
 * neither happened.
 *
 * **The audit row is written from the value read inside the transaction**, not
 * from anything the caller sent, so `previous*` is what was actually there.
 *
 * **An open session cannot be given an end here.** Closing a shift is
 * `closeSessionTx`'s job and belongs to the logout and staleness paths; an
 * administrator reaching into an open session to end it would be racing the
 * agent's own heartbeat, which reopens nothing but would leave the two writing
 * the same row from different directions. Corrections are for shifts that have
 * finished — which is also when somebody notices they were wrong.
 *
 * Nothing here touches `activity_intervals`. Intervals record what was observed
 * and are never rewritten; a correction changes the shift they sit inside, and
 * the active/idle split re-derives itself on the next read.
 */
export async function applyTimeAdjustment(
  adminId: string,
  input: AdjustmentInput,
): Promise<TimeAdjustmentCard> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new AdjustmentError(
      "reason_required",
      "Give a reason for the correction — it is kept with the record.",
      400,
    );
  }
  if (reason.length > 500) {
    throw new AdjustmentError("reason_too_long", "Keep the reason under 500 characters.", 400);
  }

  const nextStartedAt = parseInstant(input.startedAt, "startedAt");
  const nextEndedAt = parseInstant(input.endedAt, "endedAt");

  if (!nextStartedAt && !nextEndedAt) {
    throw new AdjustmentError("no_changes", "Nothing to change.", 400);
  }

  const row = await prisma.$transaction(async (tx) => {
    const session = await tx.workSession.findUnique({
      where: { id: input.workSessionId },
      select: {
        id: true,
        userId: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        user: { select: { name: true } },
      },
    });

    if (!session) {
      throw new AdjustmentError("not_found", "No such work session.", 404);
    }

    if (!session.endedAt) {
      throw new AdjustmentError(
        "session_open",
        "That shift is still running. Corrections are only made to finished sessions.",
        409,
      );
    }

    const startedAt = nextStartedAt ?? session.startedAt;
    const endedAt = nextEndedAt ?? session.endedAt;

    if (endedAt <= startedAt) {
      throw new AdjustmentError(
        "invalid_range",
        "The end of a shift must be after its start.",
        422,
      );
    }

    const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    if (durationSeconds > MAX_SESSION_SECONDS) {
      throw new AdjustmentError(
        "invalid_range",
        "A single shift cannot be longer than 24 hours.",
        422,
      );
    }

    // A shift that has not happened yet is not a correction of anything.
    if (endedAt.getTime() > Date.now() + 60_000) {
      throw new AdjustmentError("invalid_range", "A shift cannot end in the future.", 422);
    }

    const adjustment = await tx.timeAdjustment.create({
      data: {
        adminId,
        userId: session.userId,
        workSessionId: session.id,
        previousStartedAt: session.startedAt,
        previousEndedAt: session.endedAt,
        previousDurationSeconds: session.durationSeconds,
        newStartedAt: startedAt,
        newEndedAt: endedAt,
        newDurationSeconds: durationSeconds,
        reason,
      },
      select: { id: true, createdAt: true },
    });

    await tx.workSession.update({
      where: { id: session.id },
      data: {
        startedAt,
        endedAt,
        durationSeconds,
        // Kept distinct from `logout`, `timeout` and `superseded` so a row that
        // was corrected says so on its face, without a join.
        endedReason: "adjusted",
      },
    });

    return {
      id: adjustment.id,
      createdAt: adjustment.createdAt,
      agentName: session.user.name,
      workSessionId: session.id,
      previousStartedAt: session.startedAt,
      previousEndedAt: session.endedAt,
      previousDurationSeconds: session.durationSeconds,
      newStartedAt: startedAt,
      newEndedAt: endedAt,
      newDurationSeconds: durationSeconds,
      reason,
    };
  });

  const admin = await prisma.user.findUnique({
    where: { id: adminId },
    select: { name: true },
  });

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    adminName: admin?.name ?? "—",
    agentName: row.agentName,
    workSessionId: row.workSessionId,
    previousStartedAt: row.previousStartedAt.toISOString(),
    previousEndedAt: row.previousEndedAt?.toISOString() ?? null,
    previousDurationSeconds: row.previousDurationSeconds,
    newStartedAt: row.newStartedAt.toISOString(),
    newEndedAt: row.newEndedAt?.toISOString() ?? null,
    newDurationSeconds: row.newDurationSeconds,
    reason: row.reason,
  };
}

function parseInstant(raw: string | null | undefined, field: string): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AdjustmentError("invalid_timestamps", `${field} must be an ISO 8601 instant.`, 400);
  }
  return parsed;
}

/** The audit trail, newest first. ADMIN only, enforced at the route. */
export async function listAdjustments(params: {
  userId?: string | null;
  workSessionId?: string | null;
  limit?: number;
}): Promise<TimeAdjustmentCard[]> {
  const rows = await prisma.timeAdjustment.findMany({
    where: {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.workSessionId ? { workSessionId: params.workSessionId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(params.limit ?? 50, 200),
    select: {
      id: true,
      createdAt: true,
      workSessionId: true,
      previousStartedAt: true,
      previousEndedAt: true,
      previousDurationSeconds: true,
      newStartedAt: true,
      newEndedAt: true,
      newDurationSeconds: true,
      reason: true,
      admin: { select: { name: true } },
      user: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    adminName: row.admin.name,
    agentName: row.user.name,
    workSessionId: row.workSessionId,
    previousStartedAt: row.previousStartedAt.toISOString(),
    previousEndedAt: row.previousEndedAt?.toISOString() ?? null,
    previousDurationSeconds: row.previousDurationSeconds,
    newStartedAt: row.newStartedAt.toISOString(),
    newEndedAt: row.newEndedAt?.toISOString() ?? null,
    newDurationSeconds: row.newDurationSeconds,
    reason: row.reason,
  }));
}
