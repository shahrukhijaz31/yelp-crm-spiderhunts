import { prisma } from "./prisma";
import {
  type MyScreenshotCursor,
  type MyScreenshotPayload,
  encodeMyScreenshotCursor,
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
 * So the agent path is its own two functions, and in both of them `userId` is a
 * required first argument that the callers take from the session row. There is
 * no parameter, no default and no optional form: a call site that has not
 * decided whose screenshots it wants does not compile. The clause is in the
 * `where` of every query below, not in a guard beside it, which is what makes
 * "an agent can only retrieve their own" a property of the statement sent to
 * Postgres rather than of a check somebody has to remember to run first.
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

/**
 * One page of the caller's own screenshots, newest first.
 *
 * `userId` is the authenticated user. `cursor` is a position, never a subject —
 * see the note on {@link MyScreenshotCursor}. A cursor taken from somebody
 * else's browser still reads this user's rows, because the two clauses are
 * ANDed and only one of them decides whose list this is.
 *
 * `take: limit + 1` is how "is there another page" is answered without a
 * `count()`: the extra row is looked at and thrown away. A count over an
 * agent's whole history would be a second full-table read on every scroll to
 * tell the reader a number the gallery does not show.
 */
export async function myScreenshotPage(
  userId: string,
  cursor: MyScreenshotCursor | null,
  limit: number,
): Promise<MyScreenshotPayload> {
  const rows = await prisma.screenshot.findMany({
    where: {
      // The authenticated subject. Never absent, never from the request.
      userId,
      // Keyset: strictly older than the last row of the previous page, with the
      // id breaking a tie so two captures in the same millisecond can neither
      // be shown twice nor skipped.
      ...(cursor
        ? {
            OR: [
              { capturedAt: { lt: cursor.capturedAt } },
              { capturedAt: cursor.capturedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      capturedAt: true,
      width: true,
      height: true,
      fileSize: true,
      // Never `storageKey`, and never the user — one is a filesystem detail and
      // the other is a name this payload has no reason to carry. A column that
      // is not selected cannot be leaked by a careless serialisation.
      workSessionId: true,
      workSession: { select: { startedAt: true, endedAt: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  const activity = await activityForPage(userId, page);

  return {
    screenshots: page.map((row) => ({
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
    nextCursor:
      hasMore && last
        ? encodeMyScreenshotCursor({ capturedAt: last.capturedAt, id: last.id })
        : null,
    hasMore,
  };
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
 * give for both. That is requirement 5 satisfied by construction rather than by
 * remembering to make the two branches match.
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
