import { DemoImageError, validateDemoImage } from "./demoImageRules";
import {
  deleteDemoImage,
  newDemoImageKey,
  putDemoImage,
} from "./demoImageStorage";
import {
  DEMO_WEBSITE_STATUSES,
  DemoWebsiteError,
  DEFAULT_DEMO_WEBSITE_STATUS,
  normaliseClientName,
  normaliseDemoUrl,
  normaliseEmail,
  normaliseName,
  normaliseNotes,
  normalisePhone,
  normaliseStatus,
  type DemoWebsiteCard,
  type DemoWebsitePayload,
  type DemoWebsiteQuery,
  type DemoWebsiteStatus,
  type DemoSortKey,
} from "./demoWebsiteRules";
import { prisma } from "./prisma";

/**
 * Everything that reads or writes `demo_websites`.
 *
 * The counterpart to `lib/leadDb.ts` for the other module, and deliberately a
 * separate file with a separate table behind it. Nothing in here reads, writes,
 * joins to or counts a lead; nothing in `lib/leadDb.ts` knows this table
 * exists. Creating a demo website writes one row here and nothing anywhere
 * else, and importing a CSV of leads writes nothing here.
 *
 * ---------------------------------------------------------------------------
 * Authorization is not here
 * ---------------------------------------------------------------------------
 * Deliberately, and for the reason `lib/screenshotViewer.ts` gives at greater
 * length. Every function below assumes the caller has already been established
 * by a guard in the route handler — `apiModule("demoWebsites")` for a read,
 * `apiAdmin()` for a write — which resolves the session row from Postgres and
 * re-reads role and module access on every request. Putting a second check
 * inside these functions would suggest they are safe to call without the first,
 * which they are not, and two checks that can disagree are worse than one that
 * cannot be skipped.
 *
 * What that means for the arguments: `id` is a *selector*. It comes out of a
 * URL, so it is client-supplied by definition, and it is used only to pick a
 * row — never as a statement about who the caller is. There is no ownership
 * column on this table for it to be compared against, because access is by
 * module rather than by record: an agent who may read one demo website may read
 * all of them, and an agent who may not read one may not read any. That is the
 * whole IDOR story here, and it is a property of the design rather than of a
 * check somebody has to remember.
 *
 * ---------------------------------------------------------------------------
 * The storage key never leaves
 * ---------------------------------------------------------------------------
 * {@link toCard} does not select it, and every read that feeds a response goes
 * through {@link CARD_FIELDS}. The one function that loads a key is
 * {@link demoWebsiteObject}, which exists for the single route that opens the
 * file. Two selects rather than one, and the second one is the reason: nothing
 * can accidentally serialise a field it was never given.
 */

/**
 * Is this string even shaped like one of our ids?
 *
 * Every lookup below runs it first, and a `false` becomes the same 404 an
 * unknown id gets. Two reasons, and only the second is about tidiness:
 *
 *   - A NUL byte reaches Postgres as an invalid text value and the driver
 *     throws, which the route would answer as a 500. A 500 on `?id=x%00` is a
 *     probe that got a *different* answer from the one a wrong id gets, and a
 *     different answer is information. Both are 404 now.
 *   - It saves a round trip to the database for a value that cannot match a
 *     row, which is what a scanner sends.
 *
 * The pattern is the cuid alphabet, deliberately not a cuid *parser*: the point
 * is to exclude separators, control characters and anything that is not
 * `[a-z0-9]`, not to re-implement a format that may change.
 */
function isPlausibleId(id: string): boolean {
  return /^[a-z0-9]{1,64}$/i.test(id);
}

/** The columns that make a card. Never `imageStorageKey` — see the note above. */
const CARD_FIELDS = {
  id: true,
  name: true,
  clientName: true,
  demoUrl: true,
  phone: true,
  email: true,
  status: true,
  notes: true,
  imageWidth: true,
  imageHeight: true,
  imageFileSize: true,
  imageUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface CardRow {
  id: string;
  name: string;
  clientName: string;
  demoUrl: string;
  phone: string | null;
  email: string | null;
  status: string;
  notes: string;
  imageWidth: number | null;
  imageHeight: number | null;
  imageFileSize: number | null;
  imageUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toCard(row: CardRow): DemoWebsiteCard {
  return {
    id: row.id,
    name: row.name,
    clientName: row.clientName,
    demoUrl: row.demoUrl,
    phone: row.phone,
    email: row.email,
    status: row.status as DemoWebsiteStatus,
    notes: row.notes,
    // All four move together — an upload writes them as a set and a removal
    // clears them as a set — so one being null is enough to say there is no
    // image, and the type does not have to describe a half-uploaded state that
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * How each sort key becomes an `ORDER BY`.
 *
 * A table held here rather than a column name built from the query string. The
 * key has already been validated against a closed set by
 * `parseDemoWebsiteParams`, so this is the second of two locks on the same
 * door — but the query string is the one input to this module that reaches an
 * ordering, and "validated upstream" is not a thing to rely on alone.
 *
 * Every ordering ends with `id` as a tiebreak. Without it two rows created in
 * the same millisecond — which an import or a fast administrator can produce —
 * can swap places between one page and the next, and be shown twice or not at
 * all.
 */
function orderFor(sort: DemoWebsiteQuery["sort"]) {
  const direction = sort.direction;
  const byKey: Record<DemoSortKey, Array<Record<string, "asc" | "desc">>> = {
    created: [{ createdAt: direction }],
    updated: [{ updatedAt: direction }],
    name: [{ name: direction }],
    client: [{ clientName: direction }],
    status: [{ status: direction }],
  };
  return [...byKey[sort.key], { id: direction }];
}

/**
 * The `where` for one query.
 *
 * The search is a case-insensitive `contains` over the five fields an
 * administrator would recognise a demo by. Every one of them is a bound
 * parameter — Prisma builds a parameterised statement and the term never
 * becomes part of the SQL text — so the term is safe as arbitrary input, and
 * what bounds it is length (200 characters, in `parseDemoWebsiteParams`) and a
 * rate limit on the endpoint rather than a character filter.
 *
 * `notes` is deliberately not searched. It is the longest column and the least
 * useful to match on: an administrator looking for a demo knows its name or its
 * client, not a phrase buried in someone's note.
 */
function whereFor(query: DemoWebsiteQuery) {
  const term = query.search.trim();

  return {
    ...(query.status ? { status: query.status } : {}),
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" as const } },
            { clientName: { contains: term, mode: "insensitive" as const } },
            { demoUrl: { contains: term, mode: "insensitive" as const } },
            { phone: { contains: term, mode: "insensitive" as const } },
            { email: { contains: term, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

/**
 * One page of demo websites, with the counts the filter bar shows.
 *
 * Server-side paging and filtering, like the worklist and for the same reason:
 * the browser is handed at most `pageSize` rows however large the table gets,
 * and the narrowing is done by Postgres against an index rather than by React
 * against an array it had to download first.
 *
 * `page` is clamped *down* here rather than by the caller. A filter that
 * matches fewer rows than the URL expects should show the last page of what
 * matched, not an empty screen with a pager insisting there are results.
 */
export async function listDemoWebsites(
  query: DemoWebsiteQuery,
): Promise<DemoWebsitePayload> {
  const where = whereFor(query);

  const total = await prisma.demoWebsite.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(Math.max(1, query.page), totalPages);

  const [rows, grouped] = await Promise.all([
    prisma.demoWebsite.findMany({
      where,
      orderBy: orderFor(query.sort),
      skip: (page - 1) * query.pageSize,
      take: query.pageSize,
      select: CARD_FIELDS,
    }),
    // Unfiltered by the *status* filter on purpose — these are the numbers on
    // the filter buttons, and a count that already had the filter applied would
    // show every status but the selected one as zero. Not filtered by the
    // search either, for the same reason the worklist's tab badges are not.
    prisma.demoWebsite.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const statusCounts = Object.fromEntries(
    DEMO_WEBSITE_STATUSES.map((status) => [status, 0]),
  ) as Record<DemoWebsiteStatus, number>;
  for (const group of grouped) {
    statusCounts[group.status as DemoWebsiteStatus] = group._count._all;
  }

  return {
    demoWebsites: rows.map(toCard),
    meta: { page, pageSize: query.pageSize, total, totalPages },
    statusCounts,
  };
}

/** One demo website, for the detail view. Null when the id names nothing. */
export async function getDemoWebsite(id: string): Promise<DemoWebsiteCard | null> {
  if (!isPlausibleId(id)) return null;
  const row = await prisma.demoWebsite.findUnique({ where: { id }, select: CARD_FIELDS });
  return row ? toCard(row) : null;
}

/**
 * The storage key and format for one demo website, for the one route that
 * streams bytes.
 *
 * Separated from {@link getDemoWebsite} so the key is loaded only by the
 * handler that has to open the file, and never travels alongside the metadata
 * that goes to the browser.
 */
export async function demoWebsiteObject(
  id: string,
): Promise<{ id: string; imageStorageKey: string | null; imageFormat: string | null } | null> {
  if (!isPlausibleId(id)) return null;

  return prisma.demoWebsite.findUnique({
    where: { id },
    select: { id: true, imageStorageKey: true, imageFormat: true },
  });
}

// --- writing -----------------------------------------------------------------

/** The fields a create or an edit may set. Nothing outside this shape is read. */
export interface DemoWebsiteInput {
  name: string;
  clientName: string;
  demoUrl: string;
  phone: string | null;
  email: string | null;
  status: DemoWebsiteStatus;
  notes: string;
}

/**
 * A request body as a validated create.
 *
 * A whitelist, and the only way a row is ever built: there is no spread of the
 * body anywhere in this module, so a field the form does not offer cannot be
 * set by adding it to the JSON. `id`, `createdAt`, `updatedAt` and every one of
 * the six image columns are server-owned and unreachable from here — an
 * administrator posting `{"imageStorageKey": "../../etc/passwd"}` sets nothing,
 * because the key is not a field this function knows about.
 */
export function parseDemoWebsiteCreate(body: unknown): DemoWebsiteInput {
  const payload = (body ?? {}) as Record<string, unknown>;

  return {
    name: normaliseName(payload.name),
    clientName: normaliseClientName(payload.clientName),
    demoUrl: normaliseDemoUrl(payload.demoUrl),
    phone: normalisePhone(payload.phone),
    email: normaliseEmail(payload.email),
    status:
      payload.status === undefined
        ? DEFAULT_DEMO_WEBSITE_STATUS
        : normaliseStatus(payload.status),
    notes: normaliseNotes(payload.notes),
  };
}

/**
 * A request body as a validated *partial* edit.
 *
 * Only the keys actually present are returned, so the status dropdown and the
 * notes box cannot clobber each other when two edits land close together —
 * the same contract `parseLeadEdits` keeps for a lead. An empty result is a
 * 400 at the route, not a no-op write.
 */
export function parseDemoWebsiteEdits(body: unknown): Partial<DemoWebsiteInput> {
  const payload = (body ?? {}) as Record<string, unknown>;
  const edits: Partial<DemoWebsiteInput> = {};

  if (payload.name !== undefined) edits.name = normaliseName(payload.name);
  if (payload.clientName !== undefined) edits.clientName = normaliseClientName(payload.clientName);
  if (payload.demoUrl !== undefined) edits.demoUrl = normaliseDemoUrl(payload.demoUrl);
  if (payload.phone !== undefined) edits.phone = normalisePhone(payload.phone);
  if (payload.email !== undefined) edits.email = normaliseEmail(payload.email);
  if (payload.status !== undefined) edits.status = normaliseStatus(payload.status);
  if (payload.notes !== undefined) edits.notes = normaliseNotes(payload.notes);

  return edits;
}

/**
 * Create a demo website.
 *
 * `createdById` is the session's own user id, passed by the route from
 * `apiAdmin()` — never a value out of the body. There is no author field in the
 * request for a caller to set, which is the same design `updateLeadFields`
 * uses for lead activity: the attribution cannot be wrong because it is not
 * taken from the wire.
 */
export async function createDemoWebsite(
  input: DemoWebsiteInput,
  createdById: string,
): Promise<DemoWebsiteCard> {
  const row = await prisma.demoWebsite.create({
    data: { ...input, createdById },
    select: CARD_FIELDS,
  });
  return toCard(row);
}

/** Apply an edit. Null when the id names nothing, so the route can 404. */
export async function updateDemoWebsite(
  id: string,
  edits: Partial<DemoWebsiteInput>,
): Promise<DemoWebsiteCard | null> {
  if (!isPlausibleId(id)) return null;

  const existing = await prisma.demoWebsite.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return null;

  const row = await prisma.demoWebsite.update({
    where: { id },
    data: edits,
    select: CARD_FIELDS,
  });
  return toCard(row);
}

/**
 * Delete a demo website, and the image with it.
 *
 * **Row first, then the file.** The other order can delete the bytes and then
 * fail to delete the row, which leaves a demo website in the list whose image
 * endpoint answers 410 forever — a visibly broken record. This order can at
 * worst leave an orphaned file, which costs disk and is invisible, and the
 * failure is logged so it can be swept.
 *
 * The image delete is not silently swallowed. `deleteDemoImage` treats a
 * missing file as success, so anything that reaches the catch is a real
 * filesystem problem — a permission error, a full or unmounted disk — and
 * pretending otherwise is what leaves a store nobody knows is leaking. The
 * function reports it rather than throwing, because the caller's request *did*
 * succeed: the record is gone, and the administrator should be told about the
 * file rather than shown a failure for a delete that happened.
 *
 * Returns `null` when the id names nothing, so a double-submitted delete reads
 * as "already gone" rather than as an error.
 */
export async function deleteDemoWebsiteRecord(
  id: string,
): Promise<{ deleted: true; imageOrphaned: boolean } | null> {
  if (!isPlausibleId(id)) return null;

  const row = await prisma.demoWebsite.findUnique({
    where: { id },
    select: { id: true, imageStorageKey: true },
  });
  if (!row) return null;

  await prisma.demoWebsite.delete({ where: { id } });

  if (!row.imageStorageKey) return { deleted: true, imageOrphaned: false };

  try {
    await deleteDemoImage(row.imageStorageKey);
    return { deleted: true, imageOrphaned: false };
  } catch (error) {
    console.error(
      `demo-website.image.orphaned demo=${id} — the row was deleted but its image could not be removed:`,
      error,
    );
    return { deleted: true, imageOrphaned: true };
  }
}

// --- the image ---------------------------------------------------------------

/**
 * Store an image against a demo website, replacing whatever was there.
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
 *   which row          **no** in the sense that matters: the id selects a row
 *                      the caller must already be an administrator to reach,
 *                      and administrators may write to every row, so there is
 *                      no boundary for a changed id to cross
 *   the filename       **no** — `file.name` is read by nobody in this module
 *
 * ---------------------------------------------------------------------------
 * Bytes first, row second, old file last
 * ---------------------------------------------------------------------------
 * The new object is written under a fresh key, then the row is pointed at it,
 * then the previous object is removed. Every failure leaves something
 * consistent:
 *
 *   write fails      nothing changed; the old image is still served
 *   update fails     the new object is deleted again, and the old row and
 *                    file are untouched
 *   old delete fails the row and the new image are correct, and one orphaned
 *                    file is logged
 *
 * The one thing this ordering makes impossible is the bad case: a row pointing
 * at a key whose bytes were already deleted.
 */
export async function saveDemoImage(params: {
  demoWebsiteId: string;
  bytes: Uint8Array;
}): Promise<DemoWebsiteCard | null> {
  if (!isPlausibleId(params.demoWebsiteId)) return null;

  const existing = await prisma.demoWebsite.findUnique({
    where: { id: params.demoWebsiteId },
    select: { id: true, imageStorageKey: true },
  });
  if (!existing) return null;

  // Format, integrity and the true dimensions, from the bytes themselves.
  const facts = validateDemoImage(params.bytes);

  const storageKey = newDemoImageKey(facts.type, existing.id);
  const fileSize = await putDemoImage(storageKey, params.bytes);

  let row;
  try {
    row = await prisma.demoWebsite.update({
      where: { id: existing.id },
      data: {
        imageStorageKey: storageKey,
        imageFormat: facts.type,
        imageWidth: facts.width,
        imageHeight: facts.height,
        imageFileSize: fileSize,
        imageUpdatedAt: new Date(),
      },
      select: CARD_FIELDS,
    });
  } catch (error) {
    // The row is what makes the file findable. Without one the bytes are
    // unreachable by anything in the application, so they are removed rather
    // than left to accumulate as garbage nobody knows how to attribute.
    await deleteDemoImage(storageKey).catch(() => {});
    throw error;
  }

  if (existing.imageStorageKey && existing.imageStorageKey !== storageKey) {
    await deleteDemoImage(existing.imageStorageKey).catch((error) => {
      console.error(
        `demo-website.image.orphaned demo=${existing.id} key was replaced but the old object could not be removed:`,
        error,
      );
    });
  }

  return toCard(row);
}

/**
 * Remove the image and clear the six columns.
 *
 * Row first, then the file, for the reason {@link deleteDemoWebsiteRecord}
 * gives: a cleared row with a stray file on disk is invisible and sweepable, a
 * row pointing at deleted bytes is a broken image in front of a client.
 *
 * Returns null when the id names nothing, and `{ removed: false }` when there
 * was no image — a second click on Remove is "already gone", not an error.
 */
export async function removeDemoImage(
  id: string,
): Promise<{ removed: boolean; imageOrphaned: boolean; card: DemoWebsiteCard } | null> {
  if (!isPlausibleId(id)) return null;

  const existing = await prisma.demoWebsite.findUnique({
    where: { id },
    select: { id: true, imageStorageKey: true },
  });
  if (!existing) return null;

  if (!existing.imageStorageKey) {
    const card = await getDemoWebsite(id);
    return card ? { removed: false, imageOrphaned: false, card } : null;
  }

  const row = await prisma.demoWebsite.update({
    where: { id },
    data: {
      imageStorageKey: null,
      imageFormat: null,
      imageWidth: null,
      imageHeight: null,
      imageFileSize: null,
      imageUpdatedAt: null,
    },
    select: CARD_FIELDS,
  });

  let imageOrphaned = false;
  try {
    await deleteDemoImage(existing.imageStorageKey);
  } catch (error) {
    imageOrphaned = true;
    console.error(
      `demo-website.image.orphaned demo=${id} — the row was cleared but its image could not be removed:`,
      error,
    );
  }

  return { removed: true, imageOrphaned, card: toCard(row) };
}

/** Both typed refusals this module can raise, for the route's error mapper. */
export function isDemoRefusal(error: unknown): error is DemoWebsiteError | DemoImageError {
  return error instanceof DemoWebsiteError || error instanceof DemoImageError;
}
