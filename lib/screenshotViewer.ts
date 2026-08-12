import { prisma } from "./prisma";
import {
  screenshotWindow,
  TIMELINE_POINT_LIMIT,
  type ScreenshotCard,
  type ScreenshotPayload,
  type ScreenshotQuery,
  type WorkSessionSummary,
} from "./screenshotViewerRules";

/**
 * Reading screenshots back, for the administrator's viewer.
 *
 * The counterpart to `lib/screenshots.ts`, which writes them. Nothing in this
 * module writes anything — no row, no file, no session — so the viewer cannot
 * be the reason a capture, a shift or a retention sweep behaves differently.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not here
 * ---------------------------------------------------------------------------
 * Deliberately. Every function below assumes the caller has already been
 * established as an administrator by `apiAdmin()` — the guard that resolves the
 * session row from Postgres and re-reads `role` on every request. Putting a
 * second role check inside these reads would suggest they are safe to call
 * without the first one, which they are not, and two checks that can disagree
 * are worse than one that cannot be skipped: every entry point into this module
 * is a route handler whose opening statement is the guard.
 *
 * What that means for `query.userId`: it is a *filter*, the agent whose day is
 * being looked at. It never decides whether the caller may see anything, so it
 * is safe for it to be an arbitrary string from a query string — the worst a
 * bad one does is match no rows.
 *
 * ---------------------------------------------------------------------------
 * Bounded by construction
 * ---------------------------------------------------------------------------
 * Every read here is bounded by a `capturedAt` window of at most one day and,
 * except the timeline, by a page. Screenshots are the highest-volume table in
 * this application, and a viewer that could be asked for "all of them" would
 * eventually be asked for exactly that. The three indexes the schema already
 * declares — `(userId, capturedAt)`, `(workSessionId, capturedAt)` and
 * `(capturedAt)` — are the three shapes of `where` this file produces, which is
 * not a coincidence: they were written for this screen.
 */

/** The `where` every read in this module shares. */
function whereFor(query: ScreenshotQuery) {
  const { from, to } = screenshotWindow(query);

  return {
    capturedAt: { gte: from, lt: to },
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.workSessionId ? { workSessionId: query.workSessionId } : {}),
  };
}

/**
 * Everything one filter produces: a page of cards, the totals above them, the
 * timeline behind them, and the shifts the picker offers.
 *
 * One call rather than four endpoints because they are one screen and they must
 * agree with each other — a summary counted from a different window than the
 * grid it sits above is a bug that looks like a rounding error. They are issued
 * concurrently; Postgres answers them off the same indexes.
 */
export async function screenshotPage(query: ScreenshotQuery): Promise<ScreenshotPayload> {
  const where = whereFor(query);

  const [rows, total, distinctAgents, latest, timeline, sessions] = await Promise.all([
    prisma.screenshot.findMany({
      where,
      // Newest first: an administrator opening this screen is asking "what is
      // happening now", and the most recent capture is the answer. The id is
      // the tiebreak so that two captures in the same millisecond cannot swap
      // places between one page and the next and be shown twice or not at all.
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        capturedAt: true,
        width: true,
        height: true,
        fileSize: true,
        // Never `storageKey`. Nothing downstream of here needs it, and a column
        // that is not selected cannot be leaked by a careless serialisation.
        user: { select: { id: true, name: true } },
        workSession: { select: { id: true, startedAt: true, endedAt: true } },
      },
    }),

    prisma.screenshot.count({ where }),

    // "Active agents" is a real count of distinct people with a capture in the
    // window, not the size of the user table.
    prisma.screenshot.findMany({
      where,
      distinct: ["userId"],
      select: { userId: true },
    }),

    prisma.screenshot.findFirst({
      where,
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    }),

    // The whole window, not the page — the strip's job is to show the shape of
    // a day that pagination has cut into pieces. Two small columns per row, and
    // a ceiling.
    prisma.screenshot.findMany({
      where,
      orderBy: { capturedAt: "asc" },
      take: TIMELINE_POINT_LIMIT,
      select: { id: true, capturedAt: true, userId: true },
    }),

    workSessionsForDay(query),
  ]);

  return {
    screenshots: rows.map(toCard),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
    summary: {
      inWindow: total,
      activeAgents: distinctAgents.length,
      latestCaptureAt: latest?.capturedAt.toISOString() ?? null,
    },
    timeline: timeline.map((row) => ({
      id: row.id,
      capturedAt: row.capturedAt.toISOString(),
      agentId: row.userId,
    })),
    timelineTruncated: timeline.length === TIMELINE_POINT_LIMIT,
    sessions,
  };
}

/**
 * The shifts the session picker offers for the selected day.
 *
 * Sessions that *overlap* the day rather than sessions that started in it: a
 * night shift beginning at 22:00 owns screenshots on both sides of midnight,
 * and a picker that only listed the day's starts would have no entry for the
 * one an administrator is looking at.
 *
 * Filtered by agent when the agent filter is set, because a list of every
 * shift by everybody is not a picker anybody can use. Not filtered by the time
 * range — narrowing the day to an hour should not remove the shift you are
 * trying to select.
 */
async function workSessionsForDay(query: ScreenshotQuery): Promise<WorkSessionSummary[]> {
  const { from, to } = screenshotWindow({
    ...query,
    // The whole day, whatever the time filter says.
    fromMinutes: null,
    toMinutes: null,
  });

  const rows = await prisma.workSession.findMany({
    where: {
      startedAt: { lt: to },
      // An open shift has no end and therefore overlaps anything that has begun.
      OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      ...(query.userId ? { userId: query.userId } : {}),
    },
    orderBy: { startedAt: "desc" },
    // A picker, not a report. Twenty shifts is already more than a day can
    // plausibly hold for one agent, and the list is a filter rather than data.
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
 * One screenshot's metadata, for the detail view.
 *
 * Same shape as a card, and deliberately so: the modal is opened from a grid
 * that already holds every field it shows, so this endpoint exists for the
 * cases the grid cannot serve — a direct request, and a check that the row is
 * still there before its bytes are asked for. It carries no storage key either.
 */
export async function screenshotCard(id: string): Promise<ScreenshotCard | null> {
  const row = await prisma.screenshot.findUnique({
    where: { id },
    select: {
      id: true,
      capturedAt: true,
      width: true,
      height: true,
      fileSize: true,
      user: { select: { id: true, name: true } },
      workSession: { select: { id: true, startedAt: true, endedAt: true } },
    },
  });

  return row ? toCard(row) : null;
}

/**
 * The storage key for a screenshot, for the one route that streams bytes.
 *
 * Separated from {@link screenshotCard} so that the key is loaded only by the
 * handler that has to open the file, and never travels alongside the metadata
 * that goes to the browser. Two selects rather than one, and the second one is
 * the reason: nothing can accidentally serialise a field it was never given.
 */
export async function screenshotObject(
  id: string,
): Promise<{ id: string; storageKey: string; format: string; userId: string } | null> {
  return prisma.screenshot.findUnique({
    where: { id },
    select: { id: true, storageKey: true, format: true, userId: true },
  });
}

interface ScreenshotRow {
  id: string;
  capturedAt: Date;
  width: number;
  height: number;
  fileSize: number;
  user: { id: string; name: string };
  workSession: { id: string; startedAt: Date; endedAt: Date | null } | null;
}

function toCard(row: ScreenshotRow): ScreenshotCard {
  return {
    id: row.id,
    capturedAt: row.capturedAt.toISOString(),
    width: row.width,
    height: row.height,
    fileSize: row.fileSize,
    agent: { id: row.user.id, name: row.user.name },
    // `workSessionId` is not nullable, so in practice this is always present.
    // It is typed and handled as optional anyway because the viewer must never
    // be the thing that crashes on a row a future migration made nullable — and
    // because inventing a shift for a screenshot that has none would be worse
    // than saying so.
    workSession: row.workSession
      ? {
          id: row.workSession.id,
          startedAt: row.workSession.startedAt.toISOString(),
          endedAt: row.workSession.endedAt?.toISOString() ?? null,
        }
      : null,
  };
}
