import { Prisma } from "./generated/prisma/client";
import type { DateRange } from "./performanceRules";
import { prisma } from "./prisma";
import {
  DEFAULT_PRODUCTIVITY_CONFIG,
  scoreProductivity,
  validateProductivityConfig,
  type AgentProductivityDetail,
  type AgentProductivityRow,
  type ProductivityConfig,
  type ProductivityFilters,
  type ProductivityReport,
  type ProductivityTotals,
} from "./productivityRules";
import { HAD_INPUT, WEIGHTED_ACTIVITY_SQL } from "./timeTracking";
import { NOW_UTC_SQL, OPEN_SESSION_END_SQL, utc } from "./workSessions";

/**
 * Agent productivity, counted by Postgres.
 *
 * The third sibling of `lib/performance.ts` and `lib/timeTracking.ts`, written
 * to the same rules and reading the same three tables they do — there is no new
 * source of data anywhere in this file, and no table of scores. Everything is a
 * `count`/`sum` with a `GROUP BY` over an indexed date range; nothing is
 * assembled by reading rows into the server, and nothing is sent to the browser
 * to be counted there. A month of work for a team of twenty returns one row per
 * agent, and the response is the same size at ten million lead activities as at
 * ten.
 *
 * ---------------------------------------------------------------------------
 * Three queries, whatever the headcount
 * ---------------------------------------------------------------------------
 * {@link collectFigures} issues exactly three aggregates plus one user list and
 * one open-shift lookup, concurrently, for the whole team at once. There is no
 * per-agent query anywhere in this module, so an N+1 is not a thing that can be
 * introduced by adding an agent — it would have to be introduced by adding a
 * query, and there is nowhere in the shape of these functions to put one.
 *
 * ---------------------------------------------------------------------------
 * Administrators are not scored, and it is enforced in SQL
 * ---------------------------------------------------------------------------
 * Every aggregate below joins `users` and filters `u.role = 'AGENT'`, and the
 * row list is built from a query with the same filter. So an administrator does
 * not appear with a zero score, or an empty score, or a hidden score — they are
 * absent from the result set before any arithmetic happens, and
 * {@link agentProductivity} answers `null` (a 404 at the route) for an admin id
 * that is asked for directly. `role` is read from the database, which is the
 * only place this application has ever read it from.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not in this file
 * ---------------------------------------------------------------------------
 * Deliberately, and for the reason `lib/performance.ts` and
 * `lib/timeTracking.ts` both give: the policy lives at the door. Every route
 * that reaches these functions is behind `apiAdmin()`, and every page behind
 * `requireRole("ADMIN")`. There is no agent-facing endpoint that calls anything
 * here, and no `userId` argument below is a permission — it is a filter.
 */

/*
 * `NOW_UTC_SQL`, `utc()` and `OPEN_SESSION_END_SQL` come from
 * `lib/workSessions.ts`; `HAD_INPUT` and `WEIGHTED_ACTIVITY_SQL` from
 * `lib/timeTracking.ts`. Every one of them is imported rather than restated, so
 * this report cannot drift into disagreeing with the time dashboard about when a
 * stale shift ended or how active an agent was.
 */

/** Only agents are scored. Applied in SQL, to every aggregate, without exception. */
const AGENTS_ONLY = Prisma.sql`u.role = 'AGENT'`;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The current targets and weights.
 *
 * Falls back to {@link DEFAULT_PRODUCTIVITY_CONFIG} when no row has been
 * written, rather than creating one on first read: a read should not write, and
 * a configuration nobody has chosen should say so on the screen (`isDefault`)
 * instead of looking like a decision somebody made.
 */
export async function readProductivityConfig(): Promise<ProductivityConfig> {
  const row = await prisma.productivitySettings.findUnique({
    where: { id: "default" },
    include: { updatedBy: { select: { name: true } } },
  });

  if (!row) {
    return {
      ...DEFAULT_PRODUCTIVITY_CONFIG,
      updatedAt: null,
      updatedByName: null,
      isDefault: true,
    };
  }

  return {
    callsTarget: row.callsTarget,
    leadsTarget: row.leadsTarget,
    meetingsTarget: row.meetingsTarget,
    followUpsTarget: row.followUpsTarget,
    activityTarget: row.activityTarget,
    callsWeight: row.callsWeight,
    leadsWeight: row.leadsWeight,
    meetingsWeight: row.meetingsWeight,
    activityWeight: row.activityWeight,
    followUpsWeight: row.followUpsWeight,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedBy?.name ?? null,
    isDefault: false,
  };
}

/**
 * Write the configuration. ADMIN only, enforced at the route.
 *
 * An upsert on the fixed id, which is the whole of the singleton enforcement:
 * there is no code path that can create a second row, so there is never a
 * question about which configuration is current. `adminId` is the session
 * user's, taken from the session row and never from the request body — there is
 * no field in the accepted shape that names an author.
 */
export async function writeProductivityConfig(
  adminId: string,
  body: unknown,
): Promise<ProductivityConfig> {
  const input = validateProductivityConfig(body);

  await prisma.productivitySettings.upsert({
    where: { id: "default" },
    create: { id: "default", ...input, updatedById: adminId },
    update: { ...input, updatedById: adminId },
  });

  return readProductivityConfig();
}

/* -------------------------------------------------------------------------- */
/* The aggregates                                                             */
/* -------------------------------------------------------------------------- */

interface LeadWorkRow {
  user_id: string;
  calls: number;
  leads_processed: number;
  meetings_booked: number;
  meetings_completed: number;
  callbacks_scheduled: number;
  follow_up_calls: number;
}

/**
 * What each agent did to leads in the window, in one pass over one index.
 *
 * Six figures from a single scan of `(user_id, created_at)` — `FILTER`ed counts
 * rather than six queries, exactly as `activityAggregate` in
 * `lib/performance.ts` does it.
 *
 * **The follow-up flag is the one non-obvious part.** A follow-up call is a
 * `call_logged` row against a lead that already had an earlier one, and "an
 * earlier one" means at any time, by anybody — a lead somebody called last month
 * and this agent called today is a follow-up, which is what the word means. It
 * is an `EXISTS` correlated on `(lead_id, created_at)`, which is an index this
 * table already carries for precisely this shape of question, so it costs one
 * index probe per call row in the window and no extra round trip. Deliberately
 * not a window function: `lag()` over the whole table partitioned by lead would
 * have to sort every call ever logged to answer a question about one week.
 */
async function leadWorkAggregate(
  range: DateRange,
  userId: string | null,
): Promise<Map<string, LeadWorkRow>> {
  const scope = userId ? Prisma.sql`AND a.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<LeadWorkRow[]>(Prisma.sql`
    WITH acts AS (
      SELECT
        a.user_id,
        a.lead_id,
        a.kind,
        (
          a.kind = 'call_logged'
          AND EXISTS (
            SELECT 1
            FROM lead_activities prior
            WHERE prior.lead_id = a.lead_id
              AND prior.kind = 'call_logged'
              AND prior.created_at < a.created_at
          )
        ) AS is_follow_up
      FROM lead_activities a
      JOIN users u ON u.id = a.user_id AND ${AGENTS_ONLY}
      WHERE a.created_at >= ${utc(range.from)} AND a.created_at < ${utc(range.to)}
      ${scope}
    )
    SELECT
      user_id,
      count(*) FILTER (WHERE kind = 'call_logged')::int                    AS calls,
      count(DISTINCT lead_id) FILTER (WHERE kind = 'call_logged')::int     AS leads_processed,
      count(*) FILTER (WHERE kind = 'meeting_booked')::int                 AS meetings_booked,
      count(*) FILTER (WHERE kind = 'meeting_completed')::int              AS meetings_completed,
      count(*) FILTER (WHERE kind = 'callback_scheduled')::int             AS callbacks_scheduled,
      count(*) FILTER (WHERE is_follow_up)::int                            AS follow_up_calls
    FROM acts
    GROUP BY user_id
  `);

  return new Map(rows.map((row) => [row.user_id, row]));
}

interface ShiftRow {
  user_id: string;
  worked_days: number;
  tracked_seconds: number;
}

/**
 * Tracked seconds and *worked days* per agent, from one join.
 *
 * Worked days are what the targets are scaled by (see the module note in
 * `lib/productivityRules.ts`), and they are counted by joining the shifts to a
 * generated series of local days rather than by grouping on
 * `date(started_at)` — the same decision, and the same reason, as `timesheet()`
 * in `lib/timeTracking.ts`. A shift from 22:00 to 02:00 is two days an agent
 * was at work, and grouping by its start would file the whole of it under the
 * first and quietly shrink their expectation.
 *
 * Summing the per-day clamped overlap also gives the window's tracked seconds
 * for free and exactly: each shift contributes to each day only the part that
 * fell in it, so the total is the overlap with the range and nothing is counted
 * twice.
 *
 * The `FILTER` on the day count is not decoration. `OPEN_SESSION_END_SQL` pulls
 * a dead shift back to its last heartbeat, so a session can satisfy the join
 * and still contribute zero seconds to that day; counting it would credit an
 * agent with a working day that produced no tracked time and then measure them
 * against a full day's target for it.
 */
async function shiftAggregate(
  range: DateRange,
  userId: string | null,
): Promise<Map<string, ShiftRow>> {
  const scope = userId ? Prisma.sql`AND ws.user_id = ${userId}` : Prisma.empty;

  // The same expression `overlapSecondsSql` builds, against columns from the
  // day series instead of literals.
  const overlap = Prisma.sql`
    greatest(
      0,
      extract(epoch FROM (
        least(coalesce(ws.ended_at, ${OPEN_SESSION_END_SQL}), d.day_start + interval '1 day')
        - greatest(ws.started_at, d.day_start)
      ))
    )
  `;

  const rows = await prisma.$queryRaw<ShiftRow[]>(Prisma.sql`
    WITH days AS (
      SELECT
        day_start,
        (row_number() OVER (ORDER BY day_start))::int - 1 AS day_index
      FROM generate_series(
        ${utc(range.from)},
        ${utc(range.to)} - interval '1 day',
        interval '1 day'
      ) AS day_start
    )
    SELECT
      ws.user_id,
      count(DISTINCT d.day_index) FILTER (WHERE ${overlap} > 0)::int AS worked_days,
      coalesce(sum(${overlap}), 0)::int                              AS tracked_seconds
    FROM days d
    JOIN work_sessions ws
      ON ws.started_at < d.day_start + interval '1 day'
     AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > d.day_start
    JOIN users u ON u.id = ws.user_id AND ${AGENTS_ONLY}
    ${scope}
    GROUP BY ws.user_id
  `);

  return new Map(rows.map((row) => [row.user_id, row]));
}

interface ActivityRow {
  user_id: string;
  active_seconds: number;
  activity_percentage: number | null;
}

/**
 * The existing activity figure per agent, over the window.
 *
 * Nothing is recalculated here: `activity_percentage` was computed by the server
 * when the interval was accepted (`lib/activityRules.ts`) and this is the same
 * duration-weighted mean of it the time dashboard shows, built from the same two
 * exported SQL fragments. Null — not zero — when no interval was observed, and
 * that null travels all the way to the score, where it makes the activity
 * component unavailable rather than a zero.
 */
async function activityAggregate(
  range: DateRange,
  userId: string | null,
): Promise<Map<string, ActivityRow>> {
  const scope = userId ? Prisma.sql`AND ai.user_id = ${userId}` : Prisma.empty;

  const rows = await prisma.$queryRaw<ActivityRow[]>(Prisma.sql`
    SELECT
      ai.user_id,
      coalesce(sum(ai.duration_seconds) FILTER (WHERE ${HAD_INPUT}), 0)::int AS active_seconds,
      ${WEIGHTED_ACTIVITY_SQL}                                               AS activity_percentage
    FROM activity_intervals ai
    JOIN users u ON u.id = ai.user_id AND ${AGENTS_ONLY}
    WHERE ai.started_at >= ${utc(range.from)} AND ai.started_at < ${utc(range.to)}
    ${scope}
    GROUP BY ai.user_id
  `);

  return new Map(rows.map((row) => [row.user_id, row]));
}

/* -------------------------------------------------------------------------- */
/* Assembling the rows                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every agent's figures over a window, scored, unfiltered and unsorted.
 *
 * Five reads, issued concurrently, none of which returns more than one row per
 * agent. Every account with `role = 'AGENT'` is listed, including the ones who
 * did nothing — an agent with a quiet week is the most useful row on a
 * performance report, and dropping them for having no activity rows would hide
 * exactly that. The same decision `teamPerformance` and `teamTimeTracking`
 * already made.
 */
async function collectFigures(
  range: DateRange,
  config: ProductivityConfig,
  userId: string | null,
): Promise<AgentProductivityRow[]> {
  const [agents, leadWork, shifts, activity, openShifts] = await Promise.all([
    prisma.user.findMany({
      // The role filter is the whole of the "administrators are never scored"
      // rule on this side, and it is a database predicate rather than something
      // dropped later in JavaScript — an admin never enters the result set.
      where: { role: "AGENT", ...(userId ? { id: userId } : {}) },
      select: { id: true, name: true, username: true, isActive: true },
      orderBy: [{ name: "asc" }],
    }),
    leadWorkAggregate(range, userId),
    shiftAggregate(range, userId),
    activityAggregate(range, userId),
    prisma.workSession.findMany({
      where: { endedAt: null, user: { role: "AGENT" }, ...(userId ? { userId } : {}) },
      select: { userId: true },
      distinct: ["userId"],
    }),
  ]);

  const online = new Set(openShifts.map((row) => row.userId));

  return agents.map((agent) => {
    const work = leadWork.get(agent.id);
    const shift = shifts.get(agent.id);
    const observed = activity.get(agent.id);

    const calls = work?.calls ?? 0;
    const meetingsCompleted = work?.meetings_completed ?? 0;
    const followUpCalls = work?.follow_up_calls ?? 0;
    const trackedSeconds = shift?.tracked_seconds ?? 0;
    const activeSeconds = observed?.active_seconds ?? 0;

    /*
     * Worked days, with one guard. An agent's calls are saved through the
     * portal, which opens a work session, so output without a shift should be
     * impossible — but "impossible" here would mean silently reporting real
     * work as unscorable, so a window with output and no measurable shift is
     * scored against a single day rather than thrown away. It is the only place
     * in this module where a figure is not read straight from a table, and it
     * only ever rounds in the agent's disfavour by treating a fragment of a day
     * as a whole one.
     */
    const measuredDays = shift?.worked_days ?? 0;
    const didSomething =
      calls > 0 || (work?.meetings_booked ?? 0) > 0 || meetingsCompleted > 0 || followUpCalls > 0;
    const workedDays = measuredDays === 0 && didSomething ? 1 : measuredDays;

    return {
      userId: agent.id,
      name: agent.name,
      username: agent.username,
      isActive: agent.isActive,
      online: online.has(agent.id),

      trackedSeconds,
      activeSeconds,
      // Floored at zero. Active is a subset of tracked by construction, but a
      // floor is cheaper than trusting that forever — the same guard
      // `agentTimeTracking` applies.
      idleSeconds: Math.max(0, trackedSeconds - activeSeconds),
      activityPercentage: observed?.activity_percentage ?? null,

      calls,
      leadsProcessed: work?.leads_processed ?? 0,
      meetingsBooked: work?.meetings_booked ?? 0,
      meetingsCompleted,
      callbacksScheduled: work?.callbacks_scheduled ?? 0,
      followUpCalls,
      followUps: followUpCalls + meetingsCompleted,

      productivity: scoreProductivity(
        {
          calls,
          leadsProcessed: work?.leads_processed ?? 0,
          meetingsBooked: work?.meetings_booked ?? 0,
          followUps: followUpCalls + meetingsCompleted,
          activityPercentage: observed?.activity_percentage ?? null,
          workedDays,
        },
        config,
      ),
      // Filled in by the caller, which is the only place that knows the whole
      // field. A rank computed inside a filtered view would be a rank among the
      // survivors of a filter, which is not what anybody reads it as.
      rank: null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The team dashboard                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The productivity report: every agent's figures over a window, ranked, then
 * filtered and sorted for the screen.
 *
 * **Rank is assigned before filtering, and that is why the agent filter is not
 * pushed into SQL here.** An agent who is third of eight is third whether or
 * not the other five are on screen, so the whole field is collected, ranked, and
 * only then narrowed — a "#1" that meant "first among the rows you happen to be
 * looking at" would be worse than no rank at all. The cost of collecting
 * everybody is the cost of the default view of this screen, which is exactly
 * what it already pays: three aggregates returning one row per agent. Narrowing
 * them by one id would save a fraction of a scan and buy a misleading number.
 *
 * The detail endpoint is the one that *does* scope in SQL — see
 * {@link agentProductivity}, which needs one agent and no ranking.
 *
 * **The filters are applied after aggregation, in JavaScript**, and that is
 * deliberate rather than lazy — the same reasoning `timeReport` sets out.
 * `minActivity` and the productivity bounds are predicates on computed values
 * (a weighted mean, and a weighted mean of capped ratios), so pushing them into
 * SQL would mean a `HAVING` over an expression the database would have to
 * rebuild for a list that is tens of rows long. The expensive part — the scans
 * over lead activities, shifts and intervals — is narrowed by the date range,
 * which *is* in SQL.
 */
export async function teamProductivity(
  range: DateRange,
  filters: ProductivityFilters,
): Promise<ProductivityReport> {
  const config = await readProductivityConfig();
  const all = await collectFigures(range, config, null);

  // Best first, agents without a score excluded — there is no honest position in
  // a ranking for somebody who could not be measured.
  const ranked = all
    .filter((row) => row.productivity.score !== null)
    .sort((a, b) => (b.productivity.score ?? 0) - (a.productivity.score ?? 0));

  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });

  let rows = all;

  if (filters.userId !== null) {
    const only = filters.userId;
    rows = rows.filter((row) => row.userId === only);
  }

  if (filters.minActivity !== null) {
    const floor = filters.minActivity;
    // An agent with no activity data is excluded by an activity floor above
    // zero rather than failing it. `null` is "not observed", and treating it as
    // 0 would report a team without the Monitor installed as failing a
    // threshold nobody measured them against.
    rows = rows.filter((row) => row.activityPercentage !== null && row.activityPercentage >= floor);
  }

  if (filters.minProductivity !== null) {
    const floor = filters.minProductivity;
    rows = rows.filter(
      (row) => row.productivity.score !== null && row.productivity.score >= floor,
    );
  }

  if (filters.maxProductivity !== null) {
    const ceiling = filters.maxProductivity;
    rows = rows.filter(
      (row) => row.productivity.score !== null && row.productivity.score <= ceiling,
    );
  }

  rows = sortRows(rows, filters);

  return {
    range: { key: range.key, from: range.fromDay, to: range.toDay, label: range.label },
    config,
    agents: rows,
    totals: totalsOf(rows),
    ranking: ranked.map((row) => ({
      userId: row.userId,
      name: row.name,
      score: row.productivity.score as number,
    })),
    asOf: new Date().toISOString(),
  };
}

/**
 * Sort, with one rule that is not obvious: an unscored agent always sorts last.
 *
 * Whichever direction is asked for. A null is not a small number — it is the
 * absence of one — and letting it lead an ascending sort by productivity would
 * put "we could not measure this person" at the top of a list of the team's
 * weakest performers.
 */
function sortRows(
  rows: readonly AgentProductivityRow[],
  filters: ProductivityFilters,
): AgentProductivityRow[] {
  const sign = filters.direction === "asc" ? 1 : -1;

  const value = (row: AgentProductivityRow): number | null => {
    switch (filters.sort) {
      case "productivity":
        return row.productivity.score;
      case "activity":
        return row.activityPercentage;
      case "calls":
        return row.calls;
      case "leads":
        return row.leadsProcessed;
      case "meetings":
        return row.meetingsBooked;
      case "tracked":
        return row.trackedSeconds;
      case "name":
        return null;
    }
  };

  return [...rows].sort((a, b) => {
    // Names are the one key where "ascending" means A→Z rather than "smaller
    // number first", so the sign is applied to the comparison directly.
    if (filters.sort === "name") {
      return sign * a.name.localeCompare(b.name);
    }

    const left = value(a);
    const right = value(b);
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return a.name.localeCompare(b.name);
    return sign * (left - right);
  });
}

/** The figures above the table, over the rows actually listed. */
function totalsOf(rows: readonly AgentProductivityRow[]): ProductivityTotals {
  const scored = rows.filter((row) => row.productivity.score !== null);

  let activityWeighted = 0;
  let activityWeight = 0;
  for (const row of rows) {
    if (row.activityPercentage === null) continue;
    activityWeighted += row.activityPercentage * row.trackedSeconds;
    activityWeight += row.trackedSeconds;
  }

  return {
    agents: rows.length,
    trackedSeconds: rows.reduce((sum, row) => sum + row.trackedSeconds, 0),
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    // Not a distinct count across the team, unlike `teamPerformance.totals`:
    // this is the sum of what each agent processed, because the column above it
    // is per agent and a total that did not add up to the column would be read
    // as an error rather than as a subtlety.
    leadsProcessed: rows.reduce((sum, row) => sum + row.leadsProcessed, 0),
    meetingsBooked: rows.reduce((sum, row) => sum + row.meetingsBooked, 0),
    followUps: rows.reduce((sum, row) => sum + row.followUps, 0),
    activityPercentage:
      activityWeight === 0 ? null : Math.round(activityWeighted / activityWeight),
    productivity:
      scored.length === 0
        ? null
        : Math.round(
            (scored.reduce((sum, row) => sum + (row.productivity.score ?? 0), 0) / scored.length) *
              10,
          ) / 10,
    unscored: rows.length - scored.length,
  };
}

/* -------------------------------------------------------------------------- */
/* One agent, in detail                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One agent's productivity over a window, with the working shown. ADMIN only,
 * enforced at the route.
 *
 * Returns null — a 404 at the route — for an id that names nobody *and* for one
 * that names an administrator. The two are the same answer on purpose: this
 * endpoint has no productivity to report for an admin account, and saying so
 * differently would be describing the account list to somebody who asked about
 * a score.
 */
export async function agentProductivity(
  agentId: string,
  range: DateRange,
): Promise<AgentProductivityDetail | null> {
  const config = await readProductivityConfig();
  const rows = await collectFigures(range, config, agentId);
  const row = rows[0];
  if (!row) return null;

  return {
    agent: {
      id: row.userId,
      name: row.name,
      username: row.username,
      isActive: row.isActive,
    },
    range: { key: range.key, from: range.fromDay, to: range.toDay, label: range.label },
    config,
    row,
    asOf: new Date().toISOString(),
  };
}
