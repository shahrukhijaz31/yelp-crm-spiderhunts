import type { Role, SessionUser } from "./access";
import {
  AppUsageError,
  share,
  validateAppUsageSubmission,
  type AppUsageApplication,
  type AppUsageReport,
  type AppUsageFilters,
  type AppUsageTimeline,
  type EmployeeAppUsage,
} from "./appUsageRules";
import { Prisma } from "./generated/prisma/client";
import type { DateRange } from "./performanceRules";
import { prisma } from "./prisma";
import { WEIGHTED_ACTIVITY_SQL } from "./timeTracking";
import { getActiveWorkSession, NOW_UTC_SQL, overlapSecondsSql, utc } from "./workSessions";

/**
 * App usage: storing one segment, and counting all of them.
 *
 * The write half is the counterpart to `lib/activity.ts` and is written to the
 * same rules — read that file's header first, because almost everything true
 * there is true here. The read half is the counterpart to `lib/timeTracking.ts`
 * and follows its one rule: every figure is a `sum`/`count` over an indexed
 * range, nothing is assembled by reading rows into the server, and nothing is
 * sent to the browser to be counted there.
 *
 * ---------------------------------------------------------------------------
 * What the client is allowed to decide
 * ---------------------------------------------------------------------------
 *   `processName` / `applicationName`  yes — bounded, normalised, and refused
 *                                      if they carry a path, a URL or control
 *                                      characters
 *   `startedAt` / `endedAt`            yes — validated against the server's
 *                                      clock *and* against the shift
 *   `clientKey`                        yes — it is the client's own retry token
 *   ------------------------------------------------------------------------
 *   `userId`                           **no** — from the authenticated device
 *   `workSessionId`                    **no** — from the portal's own view
 *   `monitorDeviceId`                  **no** — the device row that authenticated
 *   `durationSeconds`                  **no** — derived from the two timestamps
 *
 * There is no field in a submission that says whose usage it is, so an agent
 * cannot file a segment against another account or another shift. As with
 * screenshots and activity, this is not a check that could be forgotten — the
 * information is not taken from the request at all.
 *
 * ---------------------------------------------------------------------------
 * No active shift, no segment — and never the other way round
 * ---------------------------------------------------------------------------
 * **This module never writes to `work_sessions`.** It does not open one, does
 * not extend one, does not touch `last_seen_at`, and does not close one. A
 * submission arriving for an agent with no open shift is a 409; the shift is not
 * created to receive it. That is the single most important line in this file —
 * the desktop client must not be able to start or prolong somebody's recorded
 * working day, and the only way to guarantee that is for this path to have no
 * write to that table anywhere in it.
 *
 * It also never writes to `activity_intervals` and never reads
 * `lib/productivity.ts`. App usage is a third, independent data source under a
 * work session; the existing activity calculation and productivity score are
 * unchanged by anything here.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not in this file
 * ---------------------------------------------------------------------------
 * Deliberately, and for the reason `lib/timeTracking.ts` gives: the policy lives
 * at the door. The write path is behind `monitorDevice()`, which is AGENT-only
 * and re-reads role and `isActive` from Postgres on every call; every read below
 * is behind `apiAdmin()` at its route and `requireRole("ADMIN")` at its page. A
 * `userId` argument here is a *filter*, never a permission — and unlike time
 * tracking there is no agent-facing counterpart to these reads at all, because
 * the brief is explicit that app usage is admin-only.
 */

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** What the route sends back. Deliberately thin, and it carries no client key. */
export interface StoredAppUsage {
  id: string;
  processName: string;
  applicationName: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  /** The shift it was attributed to — server-resolved, returned for the log. */
  workSessionId: string;
  /** False when this was a retry and the row already existed. */
  created: boolean;
}

export async function recordAppUsage(params: {
  /** The authenticated agent, from the monitor device. Never from the body. */
  user: SessionUser;
  /** `monitor_devices.id` — which workstation reported it. Never from the body. */
  deviceId: string;
  /** The parsed JSON body, entirely untrusted. */
  body: unknown;
}): Promise<StoredAppUsage> {
  const { user, deviceId } = params;

  // Refused before the body is even looked at, exactly as `recordActivityInterval`
  // does: an agent who is not on the clock has no shift for usage to belong to,
  // and `work_session_id` is not nullable precisely so this cannot be skipped.
  // Nothing below creates one.
  const active = await getActiveWorkSession(user.id);
  if (!active) {
    throw new AppUsageError(
      "no_active_work_session",
      "No active work session. App usage is only accepted while you are on the clock.",
      409,
    );
  }

  const submission = validateAppUsageSubmission(params.body, {
    now: new Date(),
    sessionStartedAt: new Date(active.startedAt),
  });

  const data = {
    userId: user.id,
    workSessionId: active.id,
    deviceId,
    processName: submission.processName,
    applicationName: submission.applicationName,
    startedAt: submission.startedAt,
    endedAt: submission.endedAt,
    durationSeconds: submission.durationSeconds,
    clientKey: submission.clientKey,
  };

  try {
    const row = await prisma.appUsage.create({ data, select: { id: true } });

    return {
      id: row.id,
      workSessionId: active.id,
      processName: data.processName,
      applicationName: data.applicationName,
      startedAt: data.startedAt.toISOString(),
      endedAt: data.endedAt.toISOString(),
      durationSeconds: data.durationSeconds,
      created: true,
    };
  } catch (error) {
    /*
     * The retry path. `P2002` is the unique index on `client_key` doing its job
     * — the segment is already stored, so this is a success that happens to be
     * the second delivery of one.
     *
     * The *stored* row is returned rather than what was just submitted, so a
     * client that retried with a slightly different window is told what the
     * server actually holds rather than being led to believe its second version
     * won. First write wins, visibly.
     *
     * The shift is deliberately not part of the match. A retry that arrives
     * after the agent's shift rolled over is still the same segment, and
     * answering "duplicate" is both true and the only answer that keeps the
     * client's retry loop terminating.
     *
     * A key that belongs to **somebody else** is the one case that is not a
     * duplicate. It is refused with its own code rather than answered as one,
     * because telling workstation B that workstation A's segment is "already
     * stored" would let B conclude its own data had landed when it never did.
     */
    if (isUniqueViolation(error)) {
      const existing = await prisma.appUsage.findUnique({
        where: { clientKey: submission.clientKey },
        select: {
          id: true,
          userId: true,
          workSessionId: true,
          processName: true,
          applicationName: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
        },
      });

      if (existing && existing.userId === user.id) {
        return {
          id: existing.id,
          workSessionId: existing.workSessionId,
          processName: existing.processName,
          applicationName: existing.applicationName,
          startedAt: existing.startedAt.toISOString(),
          endedAt: existing.endedAt.toISOString(),
          durationSeconds: existing.durationSeconds,
          created: false,
        };
      }

      if (existing) {
        throw new AppUsageError(
          "client_key_conflict",
          "That clientKey is already in use. Generate a fresh one for this segment.",
          409,
        );
      }
    }

    throw error;
  }
}

/**
 * Prisma's unique-constraint failure, without importing the error class.
 *
 * The same helper `lib/activity.ts` keeps, and for the same reason: importing
 * `PrismaClientKnownRequestError` to `instanceof` against would tie this module
 * to the generated namespace for one string comparison. The code is stable API.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many applications are listed before the rest becomes "Other".
 *
 * A report is read, not scrolled. Eight rows covers every application anybody
 * spends real time in; the tail is a long list of installers, dialogs and
 * one-minute utilities whose individual names tell a reader nothing. The fold
 * loses no *time* — "Other" carries the whole remainder, so the column still
 * adds up to the total.
 */
const TOP_APPLICATIONS = 8;

/**
 * The longest timeline a single request will return.
 *
 * The timeline is the one read in this feature that is a row per segment rather
 * than an aggregate, which is exactly why it is capped: a day of switching
 * between four applications is a few hundred rows, and anything beyond this is
 * a client bug or a very long custom range. The payload says when it was
 * truncated rather than silently showing a partial day as a whole one.
 */
const TIMELINE_LIMIT = 500;

/** `user_id = ?`, or nothing. */
function agentScope(userId: string | null): Prisma.Sql {
  return userId ? Prisma.sql`AND au.user_id = ${userId}` : Prisma.empty;
}

interface Breakdown {
  applications: AppUsageApplication[];
  /** Every recorded second in the window, before the application filter. */
  totalSeconds: number;
  /** Distinct application labels in the window, before the "Other" fold. */
  distinct: number;
}

/**
 * The application breakdown for a window, counted entirely in Postgres.
 *
 * One statement and one round trip. `totals` is an ungrouped aggregate over the
 * window and therefore always yields exactly one row, which is what lets the
 * `LEFT JOIN` carry the totals back even when there is nothing to break down.
 * `apps` is grouped, ordered and `LIMIT`ed in SQL, so the server never receives
 * more than {@link TOP_APPLICATIONS} rows however many distinct applications the
 * window holds — the requirement that historical rows must not reach the browser
 * is satisfied structurally, because there is no query here that returns one row
 * per segment.
 *
 * **The application filter narrows the rows, not the denominator.** `totals`
 * deliberately does not carry it: "Chrome was 55% of the recorded time" must be
 * the same number whether or not the reader has filtered the table down to
 * Chrome, and dividing a filtered numerator by a filtered denominator would
 * report every filtered application as 100%.
 *
 * Both bounds ride `(user_id, started_at)`, `(application_name, started_at)` or
 * `(started_at)` depending on which filters are present — see the index note on
 * the model.
 */
async function applicationBreakdown(
  range: DateRange,
  filters: AppUsageFilters,
  trackedSeconds: number,
): Promise<Breakdown> {
  const rows = await prisma.$queryRaw<
    {
      total_seconds: number;
      distinct_applications: number;
      application_name: string | null;
      seconds: number | null;
      segments: number | null;
    }[]
  >(Prisma.sql`
    WITH scoped AS (
      SELECT au.application_name, au.duration_seconds
      FROM app_usage au
      WHERE au.started_at >= ${utc(range.from)} AND au.started_at < ${utc(range.to)}
      ${agentScope(filters.userId)}
    ),
    totals AS (
      SELECT
        coalesce(sum(s.duration_seconds), 0)::int      AS total_seconds,
        count(DISTINCT s.application_name)::int        AS distinct_applications
      FROM scoped s
    ),
    apps AS (
      SELECT
        s.application_name,
        sum(s.duration_seconds)::int AS seconds,
        count(*)::int                AS segments
      FROM scoped s
      WHERE TRUE ${filters.application ? Prisma.sql`AND lower(s.application_name) = lower(${filters.application})` : Prisma.empty}
      GROUP BY s.application_name
      ORDER BY seconds DESC, s.application_name ASC
      LIMIT ${TOP_APPLICATIONS}
    )
    SELECT t.total_seconds, t.distinct_applications, a.application_name, a.seconds, a.segments
    FROM totals t
    LEFT JOIN apps a ON TRUE
    ORDER BY a.seconds DESC NULLS LAST, a.application_name ASC
  `);

  const totalSeconds = rows[0]?.total_seconds ?? 0;
  const distinct = rows[0]?.distinct_applications ?? 0;

  const applications: AppUsageApplication[] = rows
    .filter((row) => row.application_name !== null)
    .map((row) => ({
      applicationName: row.application_name as string,
      seconds: row.seconds ?? 0,
      segments: row.segments ?? 0,
      shareOfAppTime: share(row.seconds ?? 0, totalSeconds) ?? 0,
      shareOfTrackedTime: share(row.seconds ?? 0, trackedSeconds) ?? 0,
    }));

  /*
   * The fold. Only when the reader is looking at everything: with an
   * application filter applied, the rest of the window is not "Other", it is
   * the thing they asked to exclude, and a row carrying it would read as part
   * of the filtered result.
   *
   * Computed as total minus what is listed rather than by a second query, so
   * the column adds up to the total by construction.
   */
  if (!filters.application) {
    const listed = applications.reduce((sum, row) => sum + row.seconds, 0);
    const rest = totalSeconds - listed;
    if (rest > 0) {
      applications.push({
        applicationName: "Other",
        seconds: rest,
        segments: 0,
        shareOfAppTime: share(rest, totalSeconds) ?? 0,
        shareOfTrackedTime: share(rest, trackedSeconds) ?? 0,
        other: true,
      });
    }
  }

  return { applications, totalSeconds, distinct };
}

/**
 * Tracked (signed-in) seconds over a window, for one agent or for everybody.
 *
 * From `work_sessions` and never from `app_usage`, which is the same rule
 * `lib/timeTracking.ts` states at length: the portal knows when somebody was
 * working, and a figure summed from a desktop client's reports would silently
 * under-report an agent whose Monitor was closed. It is the denominator of the
 * coverage figure for exactly that reason — the gap between the two is the part
 * of the day the breakdown does *not* describe, and hiding it would turn a
 * missing Monitor into a short working day.
 */
async function trackedSecondsFor(range: DateRange, userId: string | null): Promise<number> {
  const rows = await prisma.$queryRaw<{ seconds: number }[]>(Prisma.sql`
    SELECT coalesce(sum(${overlapSecondsSql(range.from, range.to)}), 0)::int AS seconds
    FROM work_sessions ws
    WHERE ws.started_at < ${utc(range.to)}
      AND coalesce(ws.ended_at, ${NOW_UTC_SQL}) > ${utc(range.from)}
    ${userId ? Prisma.sql`AND ws.user_id = ${userId}` : Prisma.empty}
  `);

  return rows[0]?.seconds ?? 0;
}

/**
 * One agent's duration-weighted activity percentage over a window.
 *
 * The same expression the time-tracking reports use, imported rather than
 * restated: a second definition of "the activity percentage" is exactly the
 * kind of thing that drifts and then makes two admin screens disagree about one
 * agent. Null — not zero — when nothing was observed, so "never tracked" and
 * "tracked and idle" stay distinguishable.
 *
 * Nothing here writes to or recalculates activity. This is a read of the
 * existing figure, shown beside app usage because the employee view asks for it.
 */
async function activityPercentageFor(
  range: DateRange,
  userId: string,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ activity_percentage: number | null }[]>(Prisma.sql`
    SELECT ${WEIGHTED_ACTIVITY_SQL} AS activity_percentage
    FROM activity_intervals ai
    WHERE ai.user_id = ${userId}
      AND ai.started_at >= ${utc(range.from)} AND ai.started_at < ${utc(range.to)}
  `);

  return rows[0]?.activity_percentage ?? null;
}

/**
 * The admin App Usage report. ADMIN only, enforced at the route and the page.
 *
 * Four aggregates at most, issued concurrently, none of which returns a row per
 * segment. A month of usage for a team of twenty is several hundred thousand
 * rows in Postgres and at most nine on the wire.
 */
export async function appUsageReport(
  range: DateRange,
  filters: AppUsageFilters,
): Promise<AppUsageReport> {
  const now = new Date();

  const trackedSeconds = await trackedSecondsFor(range, filters.userId);

  const [breakdown, employee] = await Promise.all([
    applicationBreakdown(range, filters, trackedSeconds),
    filters.userId ? employeeAppUsage(filters.userId, range, filters, trackedSeconds) : null,
  ]);

  const recordedSeconds = filters.application
    ? breakdown.applications.reduce((sum, row) => sum + row.seconds, 0)
    : breakdown.totalSeconds;

  return {
    range: { from: range.fromDay, to: range.toDay, label: range.label, key: range.key },
    filters: { agent: filters.userId, application: filters.application },
    summary: {
      recordedSeconds,
      trackedSeconds,
      coveragePercentage: share(breakdown.totalSeconds, trackedSeconds),
      applications: breakdown.distinct,
      asOf: now.toISOString(),
    },
    applications: breakdown.applications,
    employee,
  };
}

/**
 * One employee's app usage, with the two figures the brief asks for beside it.
 *
 * `trackedSeconds` is passed in when the caller has already read it for the
 * same scope, which is the whole-report case — one round trip rather than two
 * for a figure that would be identical.
 *
 * Returns null for an id that names nobody, which is what makes the id safe as
 * an arbitrary path segment: it is a filter, not a claim about who is asking.
 */
export async function employeeAppUsage(
  userId: string,
  range: DateRange,
  filters: AppUsageFilters = { userId, application: null },
  trackedSeconds?: number,
): Promise<EmployeeAppUsage | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, username: true, role: true },
  });
  if (!user) return null;

  const tracked = trackedSeconds ?? (await trackedSecondsFor(range, userId));

  const [breakdown, activityPercentage] = await Promise.all([
    applicationBreakdown(range, { ...filters, userId }, tracked),
    activityPercentageFor(range, userId),
  ]);

  return {
    user: { ...user, role: user.role as Role },
    trackedSeconds: tracked,
    activityPercentage,
    recordedSeconds: breakdown.totalSeconds,
    applications: breakdown.applications,
  };
}

/**
 * One agent's day, segment by segment. ADMIN only, and optional by design.
 *
 * The one read in this feature that returns a row per segment, which is why it
 * is bounded by {@link TIMELINE_LIMIT} and why it takes a single agent rather
 * than offering an everybody mode — a timeline across a team is not a thing
 * anybody reads, and it is the one query shape that could put a large table on
 * the wire.
 *
 * **`process_name` is selected; nothing else is.** No window title, no URL and
 * no document name exists in this table to select, so the timeline cannot show
 * one however it is rendered.
 */
export async function appUsageTimeline(
  userId: string,
  range: DateRange,
  filters: AppUsageFilters = { userId, application: null },
): Promise<AppUsageTimeline | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });
  if (!user) return null;

  const rows = await prisma.appUsage.findMany({
    where: {
      userId,
      startedAt: { gte: range.from, lt: range.to },
      ...(filters.application
        ? { applicationName: { equals: filters.application, mode: "insensitive" as const } }
        : {}),
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    // One more than the cap, so "there were more" is known without a count.
    take: TIMELINE_LIMIT + 1,
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      durationSeconds: true,
      applicationName: true,
      processName: true,
      // Never `clientKey`. It is a write-side retry token with no meaning to a
      // reader, and a column not selected cannot be leaked by a careless
      // serialisation — the same discipline `recentIntervals` applies.
    },
  });

  const truncated = rows.length > TIMELINE_LIMIT;

  return {
    user,
    range: { from: range.fromDay, to: range.toDay, label: range.label },
    entries: rows.slice(0, TIMELINE_LIMIT).map((row) => ({
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt.toISOString(),
      durationSeconds: row.durationSeconds,
      applicationName: row.applicationName,
      processName: row.processName,
    })),
    truncated,
  };
}

/**
 * The distinct application labels seen recently, for the filter picker.
 *
 * Bounded twice — by the window and by the limit — because it feeds a
 * `<select>`, and a picker with four thousand options is a picker nobody can
 * use. Ordered by time spent rather than alphabetically so the applications
 * that matter are at the top of the list.
 */
export async function knownApplications(range: DateRange, limit = 40): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ application_name: string }[]>(Prisma.sql`
    SELECT au.application_name
    FROM app_usage au
    WHERE au.started_at >= ${utc(range.from)} AND au.started_at < ${utc(range.to)}
    GROUP BY au.application_name
    ORDER BY sum(au.duration_seconds) DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => row.application_name);
}
