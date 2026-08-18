import { validateDemoImage } from "./demoImageRules";
import { deleteDemoImage, newDemoImageKey, putDemoImage } from "./demoImageStorage";
import { normaliseDemoUrl, type DemoSummary, type DemoSummaryMap } from "./demoWebsiteRules";
import { prisma } from "./prisma";

/**
 * The demo-specific half of a lead: reading it, and writing the two fields it
 * holds.
 *
 * ---------------------------------------------------------------------------
 * This module knows almost nothing
 * ---------------------------------------------------------------------------
 * It reads and writes an image and a link. It does not list leads, filter them,
 * sort them, page them or search them — all of that is `lib/leadDb.ts`, used
 * unchanged by both views, which is the entire point of the correction this
 * file is part of. The Demo Websites screen asks `listLeadsPage` for a page of
 * leads exactly as the worklist does, and then asks {@link demoSummariesFor}
 * for the demo metadata belonging to *those* ids.
 *
 * A consequence worth stating: **a lead needs no row here to appear in the demo
 * view**. The map returned below is sparse, and a lead missing from it is drawn
 * with an empty image cell and an empty link. Nothing was backfilled when this
 * shipped and nothing needs to be.
 *
 * Another: there is no such thing as stale lead data in the demo view, because
 * there is no lead data here to be stale. A name, a phone, a status or a note
 * changed on the worklist is changed in the demo view on the next read, and no
 * code anywhere copies a lead field into this table.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not here
 * ---------------------------------------------------------------------------
 * Deliberately, and for the reason `lib/screenshotViewer.ts` gives at greater
 * length. Every function below assumes the caller has already been established
 * by a guard in the route handler — `apiModule("demoWebsites")` — which
 * resolves the session row from Postgres and re-reads role and module access on
 * every request. Putting a second check inside these functions would suggest
 * they are safe to call without the first, which they are not.
 *
 * `leadId` is a *selector*. It comes out of a URL, so it is client-supplied by
 * definition, and it is used only to pick a row — never as a statement about
 * who the caller is. There is no per-lead ownership anywhere in this
 * application: an agent who may see the lead pool may see all of it, and one
 * who may not see any. That is the whole IDOR story, and it is a property of
 * the design rather than of a check somebody has to remember.
 */

/** The columns that make a summary. Never `imageStorageKey`. */
const SUMMARY_FIELDS = {
  leadId: true,
  demoUrl: true,
  imageWidth: true,
  imageHeight: true,
  imageFileSize: true,
  imageUpdatedAt: true,
  updatedAt: true,
} as const;

interface SummaryRow {
  leadId: string;
  demoUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageFileSize: number | null;
  imageUpdatedAt: Date | null;
  updatedAt: Date;
}

function toSummary(row: SummaryRow): DemoSummary {
  return {
    leadId: row.leadId,
    demoUrl: row.demoUrl,
    // The four image columns move together — an upload writes them as a set and
    // a removal clears them as a set — so one being null is enough to say there
    // is no image, and the type does not have to describe a half-uploaded state
    // the write path cannot produce.
    image:
      row.imageWidth !== null && row.imageHeight !== null && row.imageUpdatedAt !== null
        ? {
            width: row.imageWidth,
            height: row.imageHeight,
            fileSize: row.imageFileSize ?? 0,
            updatedAt: row.imageUpdatedAt.toISOString(),
          }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Is this string even shaped like one of our ids?
 *
 * Run before every lookup, and a `false` becomes the same 404 an unknown id
 * gets. A NUL byte reaches Postgres as an invalid text value and the driver
 * throws, which the route would answer as a 500 — and a 500 on `id=x%00` is a
 * probe that got a *different* answer from the one a wrong id gets, which is
 * information. Both are 404 now.
 */
function isPlausibleId(id: string): boolean {
  return /^[a-z0-9]{1,64}$/i.test(id);
}

/**
 * Demo metadata for a page of leads, keyed by lead id.
 *
 * **Bounded by the page**, never by the table. The caller passes the ids
 * `listLeadsPage` just returned — at most 100 — so this is a single indexed
 * `IN` on a unique column however many leads the portal holds. An earlier
 * sketch fetched every demo row for the whole workspace the way
 * `/api/recordings` does; that is fine for recordings, which are rare, and
 * would have been a growing unbounded read here.
 *
 * The result is **sparse**: leads with no demo row simply have no key. Callers
 * must treat a missing entry as "no image and no link", which is the normal
 * case and not an error.
 */
export async function demoSummariesFor(leadIds: string[]): Promise<DemoSummaryMap> {
  const ids = leadIds.filter(isPlausibleId);
  if (ids.length === 0) return {};

  const rows = await prisma.demoWebsite.findMany({
    where: { leadId: { in: ids } },
    select: SUMMARY_FIELDS,
  });

  const map: DemoSummaryMap = {};
  for (const row of rows) map[row.leadId] = toSummary(row);
  return map;
}

/** One lead's demo metadata, or null when it has none yet. */
export async function demoSummaryFor(leadId: string): Promise<DemoSummary | null> {
  if (!isPlausibleId(leadId)) return null;

  const row = await prisma.demoWebsite.findUnique({
    where: { leadId },
    select: SUMMARY_FIELDS,
  });
  return row ? toSummary(row) : null;
}

/**
 * The storage key and format for one lead's demo image, for the one route that
 * streams bytes.
 *
 * Separated from {@link demoSummaryFor} so the key is loaded only by the
 * handler that has to open the file, and never travels alongside the metadata
 * that goes to the browser. Two selects rather than one, and the second one is
 * the reason: nothing can accidentally serialise a field it was never given.
 */
export async function demoImageObject(
  leadId: string,
): Promise<{ leadId: string; imageStorageKey: string | null; imageFormat: string | null } | null> {
  if (!isPlausibleId(leadId)) return null;

  return prisma.demoWebsite.findUnique({
    where: { leadId },
    select: { leadId: true, imageStorageKey: true, imageFormat: true },
  });
}

/** Whether the lead exists at all. The demo routes 404 on a lead, not on a row. */
export async function leadExists(leadId: string): Promise<boolean> {
  if (!isPlausibleId(leadId)) return false;
  return (await prisma.lead.count({ where: { id: leadId } })) > 0;
}

// --- writing -----------------------------------------------------------------

/**
 * Set or clear the demo link.
 *
 * `null` clears it. The row is *upserted*, because a lead has no demo row until
 * one of the two fields is first saved — so setting a link on a lead nobody has
 * touched creates the row, and setting it on one that already has an image
 * updates the row that image lives on.
 *
 * Clearing the link does **not** delete the row when an image is still
 * attached: the image is the other half of the same record. A row left with
 * neither is harmless and is cleaned up by {@link removeDemoImageFor} when the
 * image goes.
 *
 * Returns null when the lead does not exist, so the route can 404 rather than
 * creating demo metadata for a lead id somebody invented.
 */
export async function setDemoLink(
  leadId: string,
  rawUrl: unknown,
  actorId: string,
): Promise<DemoSummary | null> {
  if (!(await leadExists(leadId))) return null;

  // `null` is a deliberate clear; anything else must be a valid http(s) URL.
  // `normaliseDemoUrl` throws a `DemoWebsiteError` the route maps to a 400.
  const demoUrl = rawUrl === null ? null : normaliseDemoUrl(rawUrl);

  const row = await prisma.demoWebsite.upsert({
    where: { leadId },
    create: { leadId, demoUrl, updatedById: actorId },
    update: { demoUrl, updatedById: actorId },
    select: SUMMARY_FIELDS,
  });

  return toSummary(row);
}

/**
 * Store a demo image against a lead, replacing whatever was there.
 *
 * ---------------------------------------------------------------------------
 * What the client is allowed to decide
 * ---------------------------------------------------------------------------
 *   the image bytes    yes — validated and sniffed before anything is kept
 *   ----------------------------------------------------------------------
 *   the storage key    **no** — generated here by `newDemoImageKey`
 *   the stored format  **no** — sniffed from the magic bytes
 *   width / height     **no** — read out of the file's own header
 *   the file size      **no** — measured from the bytes written
 *   the filename       **no** — `file.name` is read by nobody in this module
 *   which lead         only in the sense that the id selects a lead the caller
 *                      must already have the module to reach, and the module
 *                      grants the whole pool — so there is no boundary for a
 *                      changed id to cross
 *
 * ---------------------------------------------------------------------------
 * Bytes first, row second, old file last
 * ---------------------------------------------------------------------------
 * The new object is written under a fresh key, then the row is pointed at it,
 * then the previous object is removed. Every failure leaves something
 * consistent:
 *
 *   write fails      nothing changed; the old image is still served
 *   upsert fails     the new object is deleted again, and the old row and file
 *                    are untouched
 *   old delete fails the row and the new image are correct, and one orphaned
 *                    file is logged
 *
 * The one thing this ordering makes impossible is the bad case: a row pointing
 * at a key whose bytes were already deleted.
 */
export async function saveDemoImageFor(params: {
  leadId: string;
  bytes: Uint8Array;
  actorId: string;
}): Promise<DemoSummary | null> {
  const { leadId, bytes, actorId } = params;
  if (!(await leadExists(leadId))) return null;

  const existing = await prisma.demoWebsite.findUnique({
    where: { leadId },
    select: { imageStorageKey: true },
  });

  // Format, integrity and the true dimensions, from the bytes themselves.
  // Throws a `DemoImageError` the route maps to a 413/415/422.
  const facts = validateDemoImage(bytes);

  const storageKey = newDemoImageKey(facts.type, leadId);
  const fileSize = await putDemoImage(storageKey, bytes);

  const image = {
    imageStorageKey: storageKey,
    imageFormat: facts.type,
    imageWidth: facts.width,
    imageHeight: facts.height,
    imageFileSize: fileSize,
    imageUpdatedAt: new Date(),
  };

  let row;
  try {
    row = await prisma.demoWebsite.upsert({
      where: { leadId },
      create: { leadId, updatedById: actorId, ...image },
      update: { updatedById: actorId, ...image },
      select: SUMMARY_FIELDS,
    });
  } catch (error) {
    // The row is what makes the file findable. Without one the bytes are
    // unreachable by anything in the application, so they are removed rather
    // than left to accumulate as garbage nobody knows how to attribute.
    await deleteDemoImage(storageKey).catch(() => {});
    throw error;
  }

  if (existing?.imageStorageKey && existing.imageStorageKey !== storageKey) {
    await deleteDemoImage(existing.imageStorageKey).catch((error) => {
      console.error(
        `demo.image.orphaned lead=${leadId} — the key was replaced but the old object could not be removed:`,
        error,
      );
    });
  }

  return toSummary(row);
}

/**
 * Remove the demo image and clear the six image columns.
 *
 * Row first, then the file: a cleared row with a stray file on disk is
 * invisible and sweepable, while a row pointing at deleted bytes is a broken
 * image in front of a client.
 *
 * The demo row itself is deleted when nothing is left on it — no image and no
 * link — so a lead returns to having no demo metadata at all rather than
 * keeping an empty shell. That matters for exactly one reason: the demo view
 * treats "no row" and "a row with both fields empty" identically, and only one
 * of the two should be reachable.
 *
 * `removed: false` when there was no image to begin with — a second click is
 * "already gone", not an error. Null when the lead does not exist.
 */
export async function removeDemoImageFor(
  leadId: string,
  actorId: string,
): Promise<{ removed: boolean; imageOrphaned: boolean; summary: DemoSummary | null } | null> {
  if (!(await leadExists(leadId))) return null;

  const existing = await prisma.demoWebsite.findUnique({
    where: { leadId },
    select: { imageStorageKey: true, demoUrl: true },
  });

  if (!existing || !existing.imageStorageKey) {
    return { removed: false, imageOrphaned: false, summary: await demoSummaryFor(leadId) };
  }

  let summary: DemoSummary | null = null;

  if (existing.demoUrl === null) {
    // Nothing else on the row: the whole record goes, and the lead is back to
    // having no demo metadata.
    await prisma.demoWebsite.delete({ where: { leadId } });
  } else {
    const row = await prisma.demoWebsite.update({
      where: { leadId },
      data: {
        imageStorageKey: null,
        imageFormat: null,
        imageWidth: null,
        imageHeight: null,
        imageFileSize: null,
        imageUpdatedAt: null,
        updatedById: actorId,
      },
      select: SUMMARY_FIELDS,
    });
    summary = toSummary(row);
  }

  let imageOrphaned = false;
  try {
    await deleteDemoImage(existing.imageStorageKey);
  } catch (error) {
    imageOrphaned = true;
    console.error(
      `demo.image.orphaned lead=${leadId} — the row was cleared but its image could not be removed:`,
      error,
    );
  }

  return { removed: true, imageOrphaned, summary };
}
