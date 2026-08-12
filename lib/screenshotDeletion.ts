import { prisma } from "./prisma";
import { deleteScreenshot, screenshotSize } from "./screenshotStorage";

/**
 * Deleting screenshots on purpose, one at a time or a page at a time.
 *
 * The manual counterpart to `lib/screenshotRetention.ts`, and deliberately the
 * same shape as it: file first, then row, every step idempotent, nothing
 * transactional across the two stores because nothing needs to be. Retention is
 * untouched by this module and unaffected by it — a screenshot an administrator
 * removes here is simply one the next sweep will not find, and every row this
 * module leaves behind (see below) is one the sweep still owns and will retry.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not here
 * ---------------------------------------------------------------------------
 * Same rule as `lib/screenshotViewer.ts`: every function below assumes the
 * caller has already been established as an administrator by `apiAdmin()`,
 * which resolves the session row from Postgres and re-reads `role` on every
 * request. There is no role argument here and no way to pass one — a second
 * check in this file would suggest it is safe to call without the first, and
 * two checks that can disagree are worse than one that cannot be skipped.
 *
 * ---------------------------------------------------------------------------
 * The client names a row, never a file
 * ---------------------------------------------------------------------------
 * The only value that crosses from the browser is a screenshot **id**, which is
 * a database primary key. The storage key is read off the row this module looks
 * up, exactly as the image route does; there is no parameter here that could
 * name a path, and no code path that concatenates anything caller-supplied into
 * one. `resolveKey` inside `screenshotStorage` re-resolves every key against the
 * storage root and refuses anything that escapes it, on this delete as on every
 * other read and write — belt and braces behind a key the server minted itself.
 *
 * {@link isScreenshotId} rejects anything that is not the shape of a cuid before
 * a query is issued. That is not what makes traversal impossible — the shape of
 * this module is — but it keeps a hostile string from becoming a round trip.
 *
 * ---------------------------------------------------------------------------
 * What "deleted" is allowed to mean
 * ---------------------------------------------------------------------------
 *   file gone, row gone      the goal, and the only outcome reported as deleted
 *   file already missing     still a delete: the row was pointing at nothing,
 *                            which is the one state the viewer cannot render
 *   file will not delete     the row is **kept** and the id is reported as a
 *                            failure. Removing it would strand the bytes with
 *                            nothing left in the system that knows they exist
 *   row will not delete      reported as a failure even though the file is gone.
 *                            The administrator is told rather than shown a
 *                            success that the next page load contradicts
 *   no such row              reported as a failure, not quietly counted — an id
 *                            that matched nothing did not delete anything
 *
 * One screenshot failing never stops the others: the loop is per row and every
 * outcome is recorded rather than thrown.
 */

/**
 * A cuid, or nothing. The same test `screenshotViewerRules.safeId` applies to
 * filter ids, for the same reason and with the same standing: a cheap shape
 * check, not a security boundary.
 */
export function isScreenshotId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{1,64}$/i.test(value);
}

/** Why one screenshot in a batch did not go. */
export type DeleteFailureReason =
  | "invalid_id"
  | "not_found"
  | "file_delete_failed"
  | "row_delete_failed";

export interface DeleteFailure {
  id: string;
  reason: DeleteFailureReason;
  /** Written for an administrator to read, never a path or a storage key. */
  message: string;
}

export interface ScreenshotDeleteResult {
  /** Ids whose file and row are both gone. Safe for the UI to drop. */
  deleted: string[];
  /** Ids still in the database, with the reason each one is. */
  failed: DeleteFailure[];
}

/**
 * A ceiling on one request.
 *
 * The largest page the viewer offers is 100 (`SCREENSHOT_PAGE_SIZES`), and
 * selection is page-scoped, so the UI cannot reach this. It is here for the
 * caller that is not the UI: a bulk endpoint with no cap is a way to ask one
 * request to hold the storage root open for an hour.
 */
export const MAX_BULK_DELETE = 500;

const FAILURE_MESSAGES: Record<DeleteFailureReason, string> = {
  invalid_id: "That is not a screenshot reference.",
  not_found: "No such screenshot. It may already have been deleted.",
  file_delete_failed:
    "Its image file could not be removed from storage, so the screenshot was kept.",
  row_delete_failed:
    "Its image file was removed but the record could not be deleted. It will be cleared by the retention sweep.",
};

function failure(id: string, reason: DeleteFailureReason): DeleteFailure {
  return { id, reason, message: FAILURE_MESSAGES[reason] };
}

/**
 * Delete one screenshot: its bytes, then its row.
 *
 * Ordered file-then-row for the reason retention gives — a row with no file is
 * recoverable by any later sweep, whereas a file with no row is bytes nothing in
 * the system knows about. A file that was already missing is not an error: the
 * caller's goal is "these bytes are gone", and they are.
 */
export async function deleteScreenshotById(id: string): Promise<DeleteFailure | null> {
  if (!isScreenshotId(id)) return failure(id, "invalid_id");

  const row = await prisma.screenshot.findUnique({
    where: { id },
    // The key is read here, server-side, off the row. It is never a parameter.
    select: { id: true, storageKey: true },
  });
  if (!row) return failure(id, "not_found");

  try {
    /*
     * Stat'ed before the unlink only so that a file which is present but
     * undeletable is distinguishable from one that was never there.
     * `deleteScreenshot` treats missing as success, so both paths are safe.
     */
    await screenshotSize(row.storageKey);
    await deleteScreenshot(row.storageKey);
  } catch (error) {
    console.error(
      `[screenshot-delete] could not delete the file for screenshot ${row.id}; keeping its row:`,
      error instanceof Error ? error.message : error,
    );
    return failure(id, "file_delete_failed");
  }

  try {
    await prisma.screenshot.delete({ where: { id: row.id } });
  } catch (error) {
    // Somebody else — a concurrent delete, or the retention sweep — got there
    // first. The row is gone, which is the outcome this call wanted.
    if (isMissingRecord(error)) return null;

    console.error(
      `[screenshot-delete] deleted the file for screenshot ${row.id} but could not delete its row:`,
      error instanceof Error ? error.message : error,
    );
    return failure(id, "row_delete_failed");
  }

  return null;
}

/**
 * Delete a batch, reporting each id's fate.
 *
 * Sequential rather than concurrent, deliberately. A bulk delete is a hundred
 * unlinks and a hundred small transactions against the same table; issuing them
 * all at once would put a burst on the connection pool that the interactive
 * screens share, to save a fraction of a second on an action that already has a
 * confirmation dialog in front of it.
 *
 * Duplicates are collapsed and order is preserved, so `["a","a"]` reports one
 * outcome for `a` rather than a delete and a phantom "already gone".
 */
export async function deleteScreenshots(ids: string[]): Promise<ScreenshotDeleteResult> {
  const unique = Array.from(new Set(ids));

  const result: ScreenshotDeleteResult = { deleted: [], failed: [] };

  for (const id of unique) {
    const problem = await deleteScreenshotById(id);
    if (problem) result.failed.push(problem);
    else result.deleted.push(id);
  }

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
