import type { Role } from "./access";
import { Prisma } from "./generated/prisma/client";
import { todayIso } from "./leadUtils";
import {
  addDays,
  resolveRange,
  ZERO_METRICS,
  type ActivityDay,
  type AgentPerformance,
  type DateRange,
  type PerformanceMetrics,
  type PerformanceReport,
  type PersonalPerformance,
} from "./performanceRules";
import { prisma } from "./prisma";
import { NOW_UTC_SQL, overlapSecondsSql, utc } from "./workSessions";

/**
 * Performance reporting, counted by Postgres.
 *
 * Every figure in this file is an aggregate over two tables — `lead_activities`
 * (who did what to which lead) and `work_sessions` (when they were here) — and
 * every one of them is `count`/`sum` with a `GROUP BY` over an indexed date
 * range. Nothing is ever assembled by reading rows into the server and counting
 * them in JavaScript, and nothing is ever sent to the browser to be counted
 * there: a report over a million activity rows returns one row per agent, and
 * the response is the same size at a million rows as at ten.
 *
 * **Nothing here is estimated.** There is no metric in this module that is not
 * a direct count of something an agent actually saved. Where a figure the brief
 * suggested could not be derived honestly from what the system records, it is
 * absent rather than approximated — see the note on talk time below.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not in this file, and that is deliberate
 * ---------------------------------------------------------------------------
 * These functions answer whatever they are asked. What may be asked is decided
 * by the route handlers above them (`lib/authz.ts`): the personal endpoint
 * passes the session user's own id and takes no id from the request at all, and
 * the team endpoint is behind `apiAdmin()`. Keeping the policy at the door
 * rather than sprinkled through the queries means there is one place to read to
 * know who can see what — and {@link agentPerformance} taking a `userId` filter
 * is a *filter*, never a permission.
 */

/*
 * `NOW_UTC_SQL` and `utc()` come from `lib/workSessions.ts` — see the note
 * there. Every timestamp comparison below goes through them, because these
 * columns hold naive UTC and Postgres's own `now()` does not.
 */

/** Statuses that mean a person picked up. */
const ANSWERED = Prisma.sql`('interested', 'not_interested', 'do_not_call', 'owner_not_available')`;
/** Statuses that mean the lead made up its mind — the denominator of conversion. */
const DECIDED = Prisma.sql`('interested', 'not_interested')`;

interface ActivityRow {
  user_id: string | null;
  leads_worked: number;
  calls: number;
  contacts: number;
  interested: number;
  decided: number;
  callbacks: number;
  meetings_booked: number;
  meetings_completed: number;
}

/**
 * The activity aggregate, per agent *and* for the team, in one statement.
 *
 * `GROUPING SETS ((user_id), ())` is what makes it one statement: Postgres
 * returns the per-agent rows and a team row (with a null `user_id`) from a
 * single pass over the range. The team row is not the sum of the others —
 * `count(DISTINCT lead_id)` across everybody is the number of leads the team
 * worked, and two agents calling the same lead worked one lead between them.
 *
 * Every figure is a `FILTER` on one scan rather than a separate query per
 * metric: the index on `(user_id, created_at)` is walked once for nine numbers.
 */
async function activityAggregate(
  range: DateRange,
  userId: string | null,
): Promise<Map<string | null, Omit<PerformanceMetrics, "activeSeconds">>> {
  const scope = userId ? Prisma.sql`AND a.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<ActivityRow[]>(Prisma.sql`
    SELECT
      a.user_id,
      count(DISTINCT a.lead_id) FILTER (WHERE a.kind = 'call_logged')::int          AS leads_worked,
      count(*) FILTER (WHERE a.kind = 'call_logged')::int                           AS calls,
      count(*) FILTER (WHERE a.kind = 'call_logged' AND a.status IN ${ANSWERED})::int AS contacts,
      count(*) FILTER (WHERE a.kind = 'call_logged' AND a.status = 'interested')::int AS interested,
      count(*) FILTER (WHERE a.kind = 'call_logged' AND a.status IN ${DECIDED})::int  AS decided,
      count(*) FILTER (WHERE a.kind = 'callback_scheduled')::int                    AS callbacks,
      count(*) FILTER (WHERE a.kind = 'meeting_booked')::int                        AS meetings_booked,
      count(*) FILTER (WHERE a.kind = 'meeting_completed')::int                      AS meetings_completed
    FROM lead_activities a
    WHERE a.created_at >= ${utc(range.from)} AND a.created_at < ${utc(range.to)}
    ${scope}
    GROUP BY GROUPING SETS ((a.user_id), ())
  `);

  return new Map(
    rows.map((row) => [
      row.user_id,
      {
        leadsWorked: row.leads_worked,
        calls: row.calls,
        contacts: row.contacts,
        interested: row.interested,
        decided: row.decided,
        callbacks: row.callbacks,
        meetingsBooked: row.meetings_booked,
        meetingsCompleted: row.meetings_completed,
      },
    ]),
  );
}

/**
 * Active seconds per agent, and for the team, over the same window.
 *
 * A shift is counted for the part of it that falls *inside* the range
 * (`overlapSecondsSql`), so an agent who never signs out does not have last
 * night added to today. Open sessions are included and are bounded by their own
 * last heartbeat, so a browser that crashed contributes what it was worth
 * rather than everything since.
 *
 * The team row is a plain sum, unlike the activity aggregate: two agents
 * working the same hour is genuinely two agent-hours of labour, which is what
 * "total active time" means on a team report.
 */
async function activeSecondsAggregate(
  range: DateRange,
  userId: string | null,
): Promise<Map<string | null, number>> {
  const scope = userId ? Prisma.sql`AND ws.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<{ user_id: string | null; seconds: number }[]>(Prisma.sql`
    SELECT
      ws.user_id,
      coalesce(sum(${overlapSecondsSql(range.from, range.to)}), 0)::int AS seconds
    FROM work_sessions ws
    WHERE ws.started_at < ${utc(range.to)}
      AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > ${utc(range.from)}
    ${scope}
    GROUP BY GROUPING SETS ((ws.user_id), ())
  `);

  return new Map(rows.map((row) => [row.user_id, row.seconds]));
}

/**
 * Activity per calendar day, for the chart.
 *
 * Bucketed by shifting the stored UTC instant into the server's local day —
 * the same day boundaries {@link resolveRange} uses, so a bar labelled "today"
 * holds exactly what the "Today" preset counts. The offset is taken once, from
 * the middle of the range, so a window that straddles a daylight-saving change
 * can place up to an hour of activity in the neighbouring bar; that is the only
 * inaccuracy anywhere in this module, it is bounded, and it is preferred to
 * carrying a timezone database into a bar chart.
 *
 * Days with nothing in them are filled in afterwards. A chart that silently
 * omits the quiet days is a chart that lies about the shape of a week.
 */
async function activityByDay(
  range: DateRange,
  userId: string | null,
): Promise<ActivityDay[]> {
  const scope = userId ? Prisma.sql`AND a.user_id = ${userId}` : Prisma.empty;
  // `getTimezoneOffset` counts minutes *behind* UTC, so east of Greenwich is
  // negative; negating it gives "minutes to add to UTC to get local".
  const offsetMinutes = -new Date(
    (range.from.getTime() + range.to.getTime()) / 2,
  ).getTimezoneOffset();

  const rows = await prisma.$queryRaw<
    { day: string; calls: number; leads_worked: number; meetings: number }[]
  >(Prisma.sql`
    SELECT
      to_char(a.created_at + (${offsetMinutes}::int * interval '1 minute'), 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE a.kind = 'call_logged')::int                  AS calls,
      count(DISTINCT a.lead_id) FILTER (WHERE a.kind = 'call_logged')::int AS leads_worked,
      count(*) FILTER (WHERE a.kind = 'meeting_booked')::int               AS meetings
    FROM lead_activities a
    WHERE a.created_at >= ${utc(range.from)} AND a.created_at < ${utc(range.to)}
    ${scope}
    GROUP BY 1
    ORDER BY 1
  `);

  const found = new Map(rows.map((row) => [row.day, row]));
  const days: ActivityDay[] = [];
  for (let day = range.fromDay; day <= range.toDay; day = addDays(day, 1)) {
    const row = found.get(day);
    days.push({
      day,
      calls: row?.calls ?? 0,
      leadsWorked: row?.leads_worked ?? 0,
      meetings: row?.meetings ?? 0,
    });
  }
  return days;
}

/**
 * The team report: every agent's numbers over a window, plus the totals and the
 * day-by-day shape of it.
 *
 * `userId` narrows it to one person — the report's Agent filter. It is *not* an
 * authorization boundary; the endpoint is admin-only before this is reached.
 *
 * Every account is listed, including the ones with a quiet day, because an
 * agent who worked nothing today is the single most useful row on the report
 * and dropping them for having no activity rows would hide exactly that.
 */
export async function teamPerformance(
  range: DateRange,
  userId: string | null = null,
): Promise<PerformanceReport> {
  const [users, activity, seconds, daily] = await Promise.all([
    prisma.user.findMany({
      where: userId ? { id: userId } : {},
      select: { id: true, name: true, username: true, role: true, isActive: true },
      orderBy: [{ name: "asc" }],
    }),
    activityAggregate(range, userId),
    activeSecondsAggregate(range, userId),
    activityByDay(range, userId),
  ]);

  // Who is signed in right now. One small query rather than a column on every
  // aggregate above, because it is a fact about this instant and not about the
  // window being reported on — an agent can be online now and have done nothing
  // last Tuesday.
  const online = new Set(
    (
      await prisma.workSession.findMany({
        where: { endedAt: null },
        select: { userId: true },
        distinct: ["userId"],
      })
    ).map((row) => row.userId),
  );

  const agents: AgentPerformance[] = users.map((user) => ({
    userId: user.id,
    name: user.name,
    username: user.username,
    role: user.role as Role,
    isActive: user.isActive,
    online: online.has(user.id),
    ...ZERO_METRICS,
    ...(activity.get(user.id) ?? {}),
    activeSeconds: seconds.get(user.id) ?? 0,
  }));

  const totals: PerformanceMetrics = {
    ...ZERO_METRICS,
    ...(activity.get(null) ?? {}),
    activeSeconds: seconds.get(null) ?? 0,
  };

  return { range, agents, totals, daily };
}

/**
 * One person's own numbers.
 *
 * The same aggregates as the team report, scoped to a single id that the caller
 * takes from the session and never from the request. There is no shape of
 * argument here that can return somebody else's row alongside your own: the
 * team totals are not computed, the agent list is not read, and the only id
 * that reaches Postgres is the one that was passed in.
 */
export async function personalPerformance(
  userId: string,
  range: DateRange,
): Promise<PerformanceMetrics> {
  const [activity, seconds] = await Promise.all([
    activityAggregate(range, userId),
    activeSecondsAggregate(range, userId),
  ]);

  return {
    ...ZERO_METRICS,
    ...(activity.get(userId) ?? {}),
    activeSeconds: seconds.get(userId) ?? 0,
  };
}

/**
 * Today and the last seven days, which is what the agent's own screens show.
 *
 * Both windows in one call because both are on screen at once, and reading them
 * separately would let the day totals and the week totals describe two
 * different instants — a "today" figure larger than the "last 7 days" one it
 * sits beside is the kind of thing nobody ever trusts again.
 */
export async function personalPerformanceSummary(
  userId: string,
  today = todayIso(),
): Promise<PersonalPerformance> {
  const todayRange = resolveRange("today", null, null, today);
  const weekRange = resolveRange("last7", null, null, today);

  const [todayMetrics, weekMetrics, daily] = await Promise.all([
    personalPerformance(userId, todayRange),
    personalPerformance(userId, weekRange),
    activityByDay(weekRange, userId),
  ]);

  return { today: todayMetrics, week: weekMetrics, daily, todayIso: today };
}
