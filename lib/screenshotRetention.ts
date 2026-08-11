import { prisma } from "./prisma";
import { retentionDays } from "./screenshotPolicy";
import { deleteScreenshot, screenshotSize } from "./screenshotStorage";

/**
 * Deleting screenshots that have outlived the retention window.
 *
 * ---------------------------------------------------------------------------
 * The database decides, never the filesystem
 * ---------------------------------------------------------------------------
 * This sweep walks `screenshots` rows and deletes the file each row names. It
 * never lists the storage directory, never parses a date out of a path, and
 * never deletes a file it did not find a row for. That ordering is the whole
 * safety property: a filename is a string on a disk that anything could have
 * created, whereas a row carries a server-stamped `created_at` and the storage
 * key the server itself generated.
 *
 * `created_at` is what is compared — the instant the *server* received the
 * upload — not `captured_at`, which is advisory, client-supplied and only
 * clamped to a six-hour window (`lib/screenshotRules.ts`). A workstation that
 * reported its capture as three months old would otherwise have handed itself a
 * delete-on-arrival switch.
 *
 * ---------------------------------------------------------------------------
 * File first, then row
 * ---------------------------------------------------------------------------
 *   file gone, row gone      the goal
 *   file already missing     counted, and the row is still removed — a row
 *                            pointing at nothing is the one state a viewer
 *                            cannot render
 *   file cannot be deleted   the row is **kept**. Removing it would strand the
 *                            bytes with nothing left in the system that knows
 *                            they exist. It is retried on the next sweep.
 *   crash in between         a row past its retention with no file, which the
 *                            next sweep removes
 *
 * Nothing here is transactional across the two stores, and nothing needs to be:
 * every step is idempotent, so two sweeps running at once (two application
 * instances, a cron overlapping a manual run) produce the same end state. A row
 * another sweep already deleted comes back as a missing-record error, which is
 * treated as success because it *is* the outcome asked for.
 *
 * ---------------------------------------------------------------------------
 * What is logged
 * ---------------------------------------------------------------------------
 * Counts, the cutoff and the configured window. Never a storage key, a
 * filesystem path, a user id or an agent's name — this is a log about how much
 * was deleted, and it should not become a record of who was photographed and
 * when.
 */

export interface RetentionResult {
  /** The window actually applied, after validation. */
  retentionDays: number;
  /** Rows created strictly before this instant were eligible. */
  cutoff: string;
  /** Rows examined. */
  examined: number;
  /** Files removed from the storage root. */
  filesDeleted: number;
  /** Rows whose file was already gone. Not an error. */
  filesMissing: number;
  /** Rows removed from Postgres. */
  rowsDeleted: number;
  /** Rows left in place for a later sweep, because their file would not delete. */
  failed: number;
  /** True when the safety cap stopped the sweep before the backlog was clear. */
  truncated: boolean;
  durationMs: number;
}

/** Rows per query. Small enough that a sweep never holds a large result set. */
const BATCH_SIZE = 200;

/**
 * A ceiling on one run, so the first sweep after retention is switched on — or
 * after it is shortened from a year to a month — cannot run for an hour against
 * a live database. Whatever is left is picked up by the next run, and the
 * result says so rather than reporting a clean sweep it did not perform.
 */
const MAX_ROWS_PER_RUN = 20_000;

export async function runScreenshotRetention(options?: {
  /** Override for tests. Production always uses the real clock. */
  now?: Date;
  /** Override for tests. */
  maxRows?: number;
}): Promise<RetentionResult> {
  const startedAt = Date.now();
  const days = retentionDays();
  const now = options?.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const maxRows = options?.maxRows ?? MAX_ROWS_PER_RUN;

  const result: RetentionResult = {
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    examined: 0,
    filesDeleted: 0,
    filesMissing: 0,
    rowsDeleted: 0,
    failed: 0,
    truncated: false,
    durationMs: 0,
  };

  /*
   * Paging by "oldest first, take a batch" rather than by offset: rows are
   * being deleted as we go, so an offset would skip a batch every time round.
   * The loop ends when a batch comes back empty, or when a batch yields only
   * failures — without that second condition, a directory the process cannot
   * write to would make this spin on the same 200 rows forever.
   */
  while (result.examined < maxRows) {
    const batch = await prisma.screenshot.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, storageKey: true },
      // `id` breaks ties: without a total order, two rows sharing a millisecond
      // could swap places between batches and the `skip` below would step over
      // the wrong one.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: Math.min(BATCH_SIZE, maxRows - result.examined),
      // Skip the rows a previous pass of this same run could not delete, so the
      // loop makes progress instead of re-reading them.
      ...(result.failed > 0 ? { skip: result.failed } : {}),
    });

    if (batch.length === 0) break;

    const failedBefore = result.failed;

    for (const row of batch) {
      result.examined += 1;

      try {
        /*
         * Counted before it is deleted, and deleted either way. `screenshotSize`
         * swallows every stat error into null, so treating null as "already
         * gone" and skipping the unlink would orphan a file that merely could
         * not be stat'ed. `deleteScreenshot` treats a missing file as success,
         * so the unlink is safe in both cases and only a real failure throws.
         */
        const size = await screenshotSize(row.storageKey);
        await deleteScreenshot(row.storageKey);
        if (size === null) result.filesMissing += 1;
        else result.filesDeleted += 1;
      } catch (error) {
        // The bytes are still there. Keeping the row is what makes them
        // findable — and therefore deletable — on the next run.
        result.failed += 1;
        console.error(
          `[screenshot-retention] could not delete the file for screenshot ${row.id}; keeping its row:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }

      try {
        await prisma.screenshot.delete({ where: { id: row.id } });
        result.rowsDeleted += 1;
      } catch (error) {
        // A concurrent sweep got there first. The row is gone, which is the
        // outcome this run wanted, so it is not a failure.
        if (isMissingRecord(error)) {
          result.rowsDeleted += 1;
          continue;
        }

        result.failed += 1;
        console.error(
          `[screenshot-retention] deleted the file for screenshot ${row.id} but could not delete its row:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Nothing in that batch could be removed: the storage root is unwritable or
    // the database is refusing deletes. Stop rather than loop.
    if (result.failed - failedBefore === batch.length) break;
  }

  if (result.examined >= maxRows) result.truncated = true;
  result.durationMs = Date.now() - startedAt;

  console.log(
    `[screenshot-retention] window=${days}d cutoff=${result.cutoff} examined=${result.examined} ` +
      `files=${result.filesDeleted} missing=${result.filesMissing} rows=${result.rowsDeleted} ` +
      `failed=${result.failed}${result.truncated ? " truncated=true" : ""} in ${result.durationMs}ms`,
  );

  return result;
}

/** Prisma's "record to delete does not exist". */
function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}
