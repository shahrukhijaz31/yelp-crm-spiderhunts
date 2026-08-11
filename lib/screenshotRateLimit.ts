import { prisma } from "./prisma";
import { uploadWindowSeconds } from "./screenshotPolicy";

/**
 * How often one workstation may have a screenshot accepted.
 *
 * ---------------------------------------------------------------------------
 * Why the server needs this at all
 * ---------------------------------------------------------------------------
 * The desktop scheduler already spaces its captures ten to thirty minutes
 * apart, and that is the mechanism that actually decides the cadence. This is
 * not that. This is the answer to "what if the thing uploading is not the
 * client we shipped" — a modified build, a replayed request, a script holding a
 * stolen access token, or simply a bug that turns one capture into a loop. The
 * client's spacing is a policy; this is the enforcement, and it lives on the
 * only side an agent cannot edit.
 *
 * ---------------------------------------------------------------------------
 * Not an in-process counter
 * ---------------------------------------------------------------------------
 * `lib/loginThrottle.ts` keeps its windows in a `Map`, and says plainly that it
 * is not a distributed limiter. That is a fair trade for password guessing,
 * where the real brake is scrypt. It is the wrong trade here: the portal runs
 * two PM2 workers in cluster mode (`deploy/ecosystem.config.cjs`) and two
 * blue/green slots during a deploy, so an in-process map would give a device as
 * many windows as there are workers, and a restart would clear all of them.
 *
 * So the state lives in Postgres — which this application already has, unlike
 * Redis — as one nullable column on the device row. The claim is a single
 * conditional `UPDATE`:
 *
 *     UPDATE monitor_devices
 *        SET last_screenshot_at = <server now>
 *      WHERE id = ... AND (last_screenshot_at IS NULL OR last_screenshot_at <= <cutoff>)
 *
 * One statement, so it is atomic by definition. Two workers racing the same
 * device: exactly one matches the predicate, the other updates zero rows and
 * gets the 429. No lock is taken, no transaction spans the file write, and
 * nothing has to be cleaned up if a process dies mid-request.
 *
 * ---------------------------------------------------------------------------
 * The clock
 * ---------------------------------------------------------------------------
 * `new Date()` on the application server — the same clock every other row in
 * this database is stamped with, and the same one `createdAt` uses. **Not** the
 * client's `capturedAt`, which is a string a workstation wrote and which this
 * module never reads. A workstation with a wrong clock, or a deliberately wrong
 * one, changes nothing here: the value written is the server's, and the value
 * compared against is the server's.
 *
 * ---------------------------------------------------------------------------
 * Claim first, release on failure
 * ---------------------------------------------------------------------------
 * The slot is taken *before* the image is written, because the requirement is
 * that a refused upload stores no file and creates no row. That leaves one
 * case to handle honestly: a claim that succeeds followed by a store that
 * fails. The policy is "one *successful* screenshot per window", so
 * {@link releaseUploadSlot} puts the previous value back — guarded on the
 * timestamp this request wrote, so it can never stamp on a newer claim made in
 * the meantime.
 */

export type UploadSlot =
  | {
      allowed: true;
      /**
       * What `lastScreenshotAt` held before this claim, so a failed store can
       * hand the slot back. Null means the device had never uploaded.
       */
      previousAt: Date | null;
      /** The value written, for the guarded release. */
      claimedAt: Date;
    }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Take this device's slot for the current window, or refuse.
 *
 * Never throws: a database failure here would otherwise turn into a 500 on an
 * upload that might have been perfectly fine. It fails *closed* — a limiter
 * that cannot read its own state must not wave everything through — and the
 * client's response to a 429 is the same one it has for any refusal: skip this
 * capture and let the next scheduled cycle try.
 */
export async function reserveUploadSlot(deviceId: string): Promise<UploadSlot> {
  const windowSeconds = uploadWindowSeconds();
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowSeconds * 1000);

  let previousAt: Date | null = null;
  try {
    const before = await prisma.monitorDevice.findUnique({
      where: { id: deviceId },
      select: { lastScreenshotAt: true },
    });
    previousAt = before?.lastScreenshotAt ?? null;

    const claimed = await prisma.monitorDevice.updateMany({
      where: {
        id: deviceId,
        // A revoked device cannot upload anyway — `monitorDevice()` refuses it
        // before this is reached — but the predicate costs nothing and keeps
        // the claim honest if this is ever called from somewhere else.
        revokedAt: null,
        OR: [{ lastScreenshotAt: null }, { lastScreenshotAt: { lte: cutoff } }],
      },
      data: { lastScreenshotAt: now },
    });

    if (claimed.count > 0) return { allowed: true, previousAt, claimedAt: now };
  } catch (error) {
    console.error("[screenshot-rate-limit] could not claim an upload slot:", error);
    return { allowed: false, retryAfterSeconds: windowSeconds };
  }

  // Refused. How long until the window opens, from what was actually there —
  // re-derived rather than assumed, because the row may have been claimed by a
  // concurrent request between the read and the update.
  const elapsedMs = previousAt ? now.getTime() - previousAt.getTime() : 0;
  const remaining = Math.ceil((windowSeconds * 1000 - elapsedMs) / 1000);

  return {
    allowed: false,
    retryAfterSeconds: Math.min(Math.max(remaining, 1), windowSeconds),
  };
}

/**
 * Hand a claimed slot back, because the screenshot was not stored after all.
 *
 * Guarded on the exact timestamp this request wrote: if anything has claimed
 * the slot since, the `WHERE` matches nothing and the newer claim stands.
 * Never throws — failing to release costs one skipped capture window, which is
 * not worth turning a storage error into a different error.
 */
export async function releaseUploadSlot(
  deviceId: string,
  slot: { previousAt: Date | null; claimedAt: Date },
): Promise<void> {
  await prisma.monitorDevice
    .updateMany({
      where: { id: deviceId, lastScreenshotAt: slot.claimedAt },
      data: { lastScreenshotAt: slot.previousAt },
    })
    .catch((error: unknown) => {
      console.error("[screenshot-rate-limit] could not release an upload slot:", error);
    });
}
