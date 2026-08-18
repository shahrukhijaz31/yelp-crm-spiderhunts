import { prisma } from "./prisma";
import {
  myScreenshotWindow,
  type MyScreenshotPayload,
  type MyScreenshotQuery,
  type MyWorkSessionOption,
} from "./myScreenshotsRules";

/**
 * Reading one person's own screenshots, and structurally nobody else's.
 *
 * ---------------------------------------------------------------------------
 * Why this is a separate module from `screenshotViewer.ts`
 * ---------------------------------------------------------------------------
 * The admin viewer's `whereFor()` builds `userId` out of a query parameter,
 * because that is what an administrator's filter *is*. Adding a role branch to
 * it — "and if the caller is an agent, force the parameter to their own id" —
 * would put the agent-reachable path through a function that still contains a
 * query capable of returning anybody's rows, one edit away from being wrong.
 *
 * So the agent path is its own functions, and in every one of them `userId` is
 * a required first argument that the callers take from the session row. There
 * is no parameter, no default and no optional form: a call site that has not
 * decided whose screenshots it wants does not compile. The clause is in the
 * `where` of every query below, not in a guard beside it, which is what makes
 * "an agent can only retrieve their own" a property of the statement sent to
 * Postgres rather than of a check somebody has to remember to run first.
 *
 * ---------------------------------------------------------------------------
 * Filters narrow; they never widen
 * ---------------------------------------------------------------------------
 * The query object carries a date window and a work session id, both from the
 * URL. Each is ANDed with `userId`, so the most a tampered filter can do is
 * select fewer of the caller's own rows. Another agent's shift id asks for rows
 * that are both theirs and yours and gets none — it narrows to nothing rather
 * than widening to somebody, which is why the ids do not need to be validated
 * against ownership before use, and why a nonsense one is an empty gallery
 * rather than a 400.
 *
 * ---------------------------------------------------------------------------
 * Read-only, in the same structural sense
 * ---------------------------------------------------------------------------
 * There is no `create`, `update`, `delete` or `deleteMany` in this file and no
 * function here returns anything a caller could mutate through. Deletion lives
 * in `lib/screenshotDeletion.ts` behind `/api/admin/screenshots`, retention in
 * `lib/screenshotRetention.ts` behind the cron's own bearer token, and upload
 * in `lib/screenshots.ts` behind the device token. None of the three is
 * imported here, and nothing here is imported by any of them.
 */

/** The `where` every read below shares. `userId` first, and never optional. */
function whereFor(userId: string, query: MyScreenshotQuery) {
  const window = myScreenshotWindow(query);

  return {
    // The authenticated subject. Never absent, never from the request.
    userId,
    ...(window ? { capturedAt: { gte: window.from, lt: window.to } } : {}),
    ...(query.workSessionId ? { workSessionId: query.workSessionId } : {}),
  };
}

/**
 * One page of the caller's own screenshots, newest first.
 *
 * Offset paged with a real `count`, rather than the keyset this used before the
 * screen grew page numbers. A pager that says "page 3 of 12" needs the 12, and
 * a total is the only honest way to produce one. The cost is bounded by the
 * same index the ordered read uses, and by the filters: the count is over the
 * window, not over the table.
 *
 * The id is the tiebreak in the sort so that two captures in the same
 * millisecond cannot swap places between one page and the next and be shown
 * twice or not at all.
 */
export async function myScreenshotPage(
  userId: string,
  query: MyScreenshotQuery,
): Promise<MyScreenshotPayload> {
  const where = whereFor(userId, query);

  const [rows, total, sessions] = await Promise.all([
    prisma.screenshot.findMany({
      where,
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        capturedAt: true,
        width: true,
        height: true,
        fileSize: true,
        // Never `storageKey`, and never the user — one is a filesystem detail
        // and the other is a name this payload has no reason to carry. A column
        // that is not selected cannot be leaked by a careless serialisation.
        workSessionId: true,
        workSession: { select: { startedAt: true, endedAt: true } },
      },
    }),

    prisma.screenshot.count({ where }),

    myWorkSessions(userId, query),
  ]);

  const activity = await activityForPage(userId, rows);

  return {
    screenshots: rows.map((row) => ({
      id: row.id,
      capturedAt: row.capturedAt.toISOString(),
      width: row.width,
      height: row.height,
      fileSize: row.fileSize,
      workSession: row.workSession
        ? {
            startedAt: row.workSession.startedAt.toISOString(),
            endedAt: row.workSession.endedAt?.toISOString() ?? null,
          }
        : null,
      activityPercentage: activity.get(row.id) ?? null,
    })),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
    sessions,
  };
}

/**
 * The caller's own shifts, for the picker.
 *
 * Scoped to `userId` like everything else here, so the picker cannot list a
 * colleague's shift and therefore cannot offer an id that would select nothing.
 * The date filter is honoured but the *time* filter is not — a shift that ran
 * 09:00–17:00 should stay in the list while somebody narrows the grid to the
 * afternoon, or the control they are using disappears as they use it.
 *
 * A picker, not a report: fifty is already more shifts than a person can
 * plausibly want to choose between, and the count beside each is what actually
 * makes the list usable.
 */
async function myWorkSessions(
  userId: string,
  query: MyScreenshotQuery,
): Promise<MyWorkSessionOption[]> {
  const window = myScreenshotWindow({
    ...query,
    // The whole day, whatever the time filter says.
    fromMinutes: null,
    toMinutes: null,
  });

  const rows = await prisma.workSession.findMany({
    where: {
      userId,
      ...(window
        ? {
            startedAt: { lt: window.to },
            // An open shift has no end and therefore overlaps anything that has
            // begun.
            OR: [{ endedAt: null }, { endedAt: { gt: window.from } }],
          }
        : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      _count: { select: { screenshots: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    screenshotCount: row._count.screenshots,
  }));
}

/**
 * The activity figure beside each capture, in one query rather than one each.
 *
 * The N+1 this avoids is the obvious one — a `findFirst` per card would be
 * twenty-four round trips for a page. Instead the intervals that could possibly
 * contain any capture on the page are fetched once and matched in memory.
 *
 * The query is bounded three ways so it cannot become a table scan on an agent
 * with a year of history: to the shifts the page's captures actually belong to
 * (at most one per card), to the time span the page covers, and to this user.
 * The user clause is redundant — the shift ids were read from rows already
 * scoped to them — and it is there anyway, because a redundant scope costs an
 * indexed column and removes the need to reason about the previous sentence.
 */
async function activityForPage(
  userId: string,
  page: readonly { id: string; capturedAt: Date; workSessionId: string }[],
): Promise<Map<string, number>> {
  const matched = new Map<string, number>();
  if (page.length === 0) return matched;

  const times = page.map((row) => row.capturedAt.getTime());
  const workSessionIds = [...new Set(page.map((row) => row.workSessionId))];

  const intervals = await prisma.activityInterval.findMany({
    where: {
      userId,
      workSessionId: { in: workSessionIds },
      startedAt: { lte: new Date(Math.max(...times)) },
      endedAt: { gte: new Date(Math.min(...times)) },
    },
    select: { startedAt: true, endedAt: true, activityPercentage: true },
  });

  for (const row of page) {
    const at = row.capturedAt.getTime();
    const hit = intervals.find(
      (interval) => interval.startedAt.getTime() <= at && interval.endedAt.getTime() >= at,
    );
    if (hit) matched.set(row.id, hit.activityPercentage);
  }

  return matched;
}

/**
 * The row behind one of *this user's* screenshots, for the image route.
 *
 * `findFirst` with both clauses rather than `findUnique` on the id followed by
 * a comparison. The difference matters: a `findUnique` returns another agent's
 * row and leaves the caller holding it, one forgotten `if` away from streaming
 * it. Here the ownership is part of the question asked of Postgres, so a
 * screenshot belonging to somebody else and a screenshot that never existed
 * produce the same thing — `null` — and the route above has only one answer to
 * give for both. That is "another user's id is a 404" satisfied by construction
 * rather than by remembering to make the two branches match.
 *
 * No filter reaches this. The image route is asked for one row by primary key
 * and the date window is none of its business — a link to a capture must keep
 * working whatever the gallery behind it is currently filtered to.
 *
 * `storageKey` is selected here and only here, because streaming the bytes is
 * the one thing that genuinely needs it. It never leaves the server.
 */
export async function myScreenshotObject(
  userId: string,
  id: string,
): Promise<{ id: string; storageKey: string; format: string } | null> {
  return prisma.screenshot.findFirst({
    where: { id, userId },
    select: { id: true, storageKey: true, format: true },
  });
}
