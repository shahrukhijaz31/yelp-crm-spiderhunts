import type { SessionUser } from "./access";
import { activityIntervalSeconds, expectedEventsPerMinute } from "./activityPolicy";
import {
  activityPercentage,
  ActivityError,
  validateActivitySubmission,
} from "./activityRules";
import { prisma } from "./prisma";
import { getActiveWorkSession } from "./workSessions";

/**
 * Storing an activity interval.
 *
 * The counterpart to `lib/screenshots.ts`, written to the same rules and for the
 * same reasons. Read that file's header first — almost everything true there is
 * true here.
 *
 * ---------------------------------------------------------------------------
 * What the client is allowed to decide
 * ---------------------------------------------------------------------------
 *   the event counts       yes — bounded, and never interpreted as anything
 *                          but counts
 *   `startedAt` / `endedAt` yes — validated against the server's clock *and*
 *                          against the shift, and refused if they fail
 *   `clientKey`            yes — it is the client's own retry token, scoped to
 *                          the shift the server resolved
 *   ------------------------------------------------------------------------
 *   `userId`               **no** — taken from the authenticated device
 *   `workSessionId`        **no** — looked up here, from the portal's own view
 *   `activityPercentage`   **no** — recomputed from the counts and the server's
 *                          configured rate; a submitted one is discarded
 *   `durationSeconds`      **no** — derived from the two timestamps
 *
 * There is no field in a submission that says whose activity it is, so an agent
 * cannot file activity against another account or another shift. As with
 * screenshots, this is not a check that could be forgotten — the information is
 * not taken from the request at all.
 *
 * ---------------------------------------------------------------------------
 * No active shift, no interval — and never the other way round
 * ---------------------------------------------------------------------------
 * The work session is resolved by {@link getActiveWorkSession}, the portal's own
 * read, which returns null for a shift whose heartbeat has stopped. So "the
 * agent is working" is decided by the portal, on the server, at the moment of
 * submission.
 *
 * **This module never writes to `work_sessions`.** It does not open one, does
 * not extend one, does not touch `last_seen_at`, and does not close one. An
 * activity submission arriving for an agent with no open shift is a 409 — the
 * shift is not created to receive it. That is the single most important line in
 * this file: the desktop client must not be able to start or prolong somebody's
 * recorded working day, and the only way to guarantee that is for this path to
 * have no write to that table anywhere in it.
 *
 * ---------------------------------------------------------------------------
 * Retries
 * ---------------------------------------------------------------------------
 * The Monitor may resend an interval after a network failure — it never saw the
 * response, so it cannot know whether the first attempt landed. The unique index
 * on `(work_session_id, client_key)` makes the second insert fail, and this
 * module answers with the row that already exists rather than an error. A retry
 * is therefore indistinguishable in the database from a single delivery, which
 * is exactly the property required, and it holds under concurrency because it is
 * Postgres enforcing it rather than a read-then-write in application code.
 */

/** What the route sends back. Deliberately thin, and it carries no client key. */
export interface StoredActivityInterval {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  keyboardActivityCount: number;
  mouseActivityCount: number;
  /** The server's figure, which may differ from anything the client sent. */
  activityPercentage: number;
  /** The shift it was attributed to — server-resolved, returned for the log. */
  workSessionId: string;
  /** False when this was a retry and the row already existed. */
  created: boolean;
}

export async function recordActivityInterval(params: {
  /** The authenticated agent, from the monitor device. Never from the body. */
  user: SessionUser;
  /** The parsed JSON body, entirely untrusted. */
  body: unknown;
}): Promise<StoredActivityInterval> {
  const { user } = params;

  // Refused before the body is even looked at, exactly as `saveScreenshot`
  // does: an agent who is not on the clock has no shift for activity to belong
  // to, and `work_session_id` is not nullable precisely so this cannot be
  // skipped. Nothing below creates one.
  const active = await getActiveWorkSession(user.id);
  if (!active) {
    throw new ActivityError(
      "no_active_work_session",
      "No active work session. Activity is only accepted while you are on the clock.",
      409,
    );
  }

  const now = new Date();
  const submission = validateActivitySubmission(params.body, {
    intervalSeconds: activityIntervalSeconds(),
    now,
    sessionStartedAt: new Date(active.startedAt),
  });

  // The server's own figure, from the server's own configured rate. Any
  // `activityPercentage` in the body was never read.
  const percentage = activityPercentage(
    submission.keyboardActivityCount,
    submission.mouseActivityCount,
    submission.durationSeconds,
    expectedEventsPerMinute(),
  );

  const data = {
    userId: user.id,
    workSessionId: active.id,
    startedAt: submission.startedAt,
    endedAt: submission.endedAt,
    durationSeconds: submission.durationSeconds,
    keyboardActivityCount: submission.keyboardActivityCount,
    mouseActivityCount: submission.mouseActivityCount,
    activityPercentage: percentage,
    clientKey: submission.clientKey,
  };

  try {
    const row = await prisma.activityInterval.create({
      data,
      select: { id: true, workSessionId: true },
    });

    return { ...toStored(data), id: row.id, workSessionId: row.workSessionId, created: true };
  } catch (error) {
    /*
     * The retry path. `P2001`/`P2002` is the unique index doing its job — the
     * interval is already stored, so this is a success that happens to be the
     * second delivery of one.
     *
     * The *stored* row is returned rather than what was just submitted, so a
     * client that retried with slightly different counts (a resumed buffer, a
     * recount) is told what the server actually holds rather than being led to
     * believe its second version won. First write wins, visibly.
     */
    if (isUniqueViolation(error)) {
      const existing = await prisma.activityInterval.findUnique({
        where: {
          workSessionId_clientKey: {
            workSessionId: active.id,
            clientKey: submission.clientKey,
          },
        },
        select: {
          id: true,
          workSessionId: true,
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          keyboardActivityCount: true,
          mouseActivityCount: true,
          activityPercentage: true,
        },
      });

      if (existing) {
        return {
          id: existing.id,
          workSessionId: existing.workSessionId,
          startedAt: existing.startedAt.toISOString(),
          endedAt: existing.endedAt.toISOString(),
          durationSeconds: existing.durationSeconds,
          keyboardActivityCount: existing.keyboardActivityCount,
          mouseActivityCount: existing.mouseActivityCount,
          activityPercentage: existing.activityPercentage,
          created: false,
        };
      }
    }

    throw error;
  }
}

/**
 * Prisma's unique-constraint failure, without importing the error class.
 *
 * `PrismaClientKnownRequestError` is exported from the generated client, and
 * importing it here to `instanceof` against would tie this module to the
 * generated namespace for one string comparison. The code is stable API.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toStored(data: {
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  keyboardActivityCount: number;
  mouseActivityCount: number;
  activityPercentage: number;
}): Omit<StoredActivityInterval, "id" | "workSessionId" | "created"> {
  return {
    startedAt: data.startedAt.toISOString(),
    endedAt: data.endedAt.toISOString(),
    durationSeconds: data.durationSeconds,
    keyboardActivityCount: data.keyboardActivityCount,
    mouseActivityCount: data.mouseActivityCount,
    activityPercentage: data.activityPercentage,
  };
}
