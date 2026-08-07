import type { SessionUser } from "./access";
import { isMeetingLead } from "./meetings";
import { toLead } from "./leadMapping";
import { prisma } from "./prisma";
import {
  RecordingError,
  validateUpload,
  type RecordingSummary,
} from "./recordingRules";
import {
  deleteRecording,
  newStorageKey,
  putRecording,
} from "./recordingStorage";

/**
 * Call recordings: what they are, who may touch them, and what is allowed in.
 *
 * The routes in `app/api/meetings/[leadId]/recording` are deliberately thin —
 * they parse a request and turn a result into a status code. Every decision
 * that has a security consequence is made here, once, so that the upload path,
 * the metadata path, the streaming path and the delete path cannot drift into
 * four slightly different ideas of who is allowed to do what.
 *
 * ---------------------------------------------------------------------------
 * The policy
 * ---------------------------------------------------------------------------
 *
 *   ADMIN   every recording: metadata, playback, replace, delete. The whole
 *           point of the feature is that an admin can listen to the call
 *           before walking into the meeting.
 *
 *   AGENT   may upload against any meeting, because the worklist is shared —
 *           there is no lead assignment in this app, every agent works the
 *           same list, so "meetings they are authorized to manage" is all of
 *           them and the honest check is `isMeetingLead`, not an owner column
 *           that does not exist.
 *
 *           May read, replace and delete **only what they uploaded**. A
 *           recording is a client conversation; another agent's call is not an
 *           agent's business, and an id in a URL is not authorization.
 *
 * Nothing in a request body or query string contributes to the decision. The
 * caller comes from the session row in Postgres (`lib/session.ts`), the
 * recording comes from its own row, and the comparison is between those two.
 * The `leadId` in the path is a lookup key, not a claim: it selects a row, and
 * the row is then checked against the caller.
 *
 * The UI hides buttons a role cannot use. That is tidiness. This file is what
 * stops `curl`.
 *
 * The size limit, the format list and the validation live next door in
 * `lib/recordingRules.ts`, which imports nothing — the upload UI needs them
 * too, and this file is unreachable from a client component because of the
 * Prisma import above.
 */

const RECORDING_SELECT = {
  id: true,
  leadId: true,
  uploadedById: true,
  fileName: true,
  fileType: true,
  fileSize: true,
  storageKey: true,
  durationSeconds: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} as const;

type RecordingRow = {
  id: string;
  leadId: string;
  uploadedById: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  durationSeconds: number | null;
  createdAt: Date;
  uploadedBy: { id: string; name: string };
};

/**
 * May this user see and hear this recording at all?
 *
 * Admins: yes. Agents: only their own upload. This one predicate is what the
 * metadata route, the stream route and the meetings page all consult, so an
 * agent cannot reach through one door what another door refuses them.
 */
export function canAccessRecording(user: SessionUser, row: { uploadedById: string }): boolean {
  return user.role === "ADMIN" || row.uploadedById === user.id;
}

/**
 * May this user replace or delete it?
 *
 * Same rule as access, and that is not an accident worth collapsing: they are
 * two questions that happen to have the same answer today, and separating them
 * is what makes "agents may listen to everything but only delete their own" a
 * one-line change if the business ever asks for it.
 */
export function canManageRecording(user: SessionUser, row: { uploadedById: string }): boolean {
  return user.role === "ADMIN" || row.uploadedById === user.id;
}

function toSummary(row: RecordingRow, user: SessionUser): RecordingSummary {
  return {
    id: row.id,
    leadId: row.leadId,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSize: row.fileSize,
    durationSeconds: row.durationSeconds,
    uploadedAt: row.createdAt.toISOString(),
    uploadedBy: row.uploadedBy,
    canManage: canManageRecording(user, row),
  };
}

/**
 * Load a recording by its meeting, with the caller's access already applied.
 *
 * `null` covers both "there is no recording" and "there is one but it is not
 * yours" — the caller turns either into the same 404. An agent probing lead ids
 * learns nothing from the response about which meetings other agents have
 * recorded, which is the only sensible answer to a question they should not be
 * asking.
 */
export async function getRecordingFor(
  leadId: string,
  user: SessionUser,
): Promise<RecordingRow | null> {
  const row = await prisma.meetingRecording.findUnique({
    where: { leadId },
    select: RECORDING_SELECT,
  });
  if (!row) return null;
  return canAccessRecording(user, row) ? row : null;
}

export async function getRecordingSummaryFor(
  leadId: string,
  user: SessionUser,
): Promise<RecordingSummary | null> {
  const row = await getRecordingFor(leadId, user);
  return row ? toSummary(row, user) : null;
}

/**
 * Every recording this user may see, keyed by meeting.
 *
 * Used to render the Meetings page in one query rather than one request per
 * card. The `where` is the same policy as `canAccessRecording`, expressed as a
 * filter so the rows an agent may not see are never loaded in the first place
 * — filtering after the fact is the version of this that leaks the day someone
 * returns the wrong variable.
 */
export async function listRecordingsFor(
  user: SessionUser,
): Promise<Record<string, RecordingSummary>> {
  const rows = await prisma.meetingRecording.findMany({
    where: user.role === "ADMIN" ? {} : { uploadedById: user.id },
    select: RECORDING_SELECT,
    orderBy: { createdAt: "desc" },
  });

  return Object.fromEntries(rows.map((row) => [row.leadId, toSummary(row, user)]));
}

/**
 * Confirm the meeting exists and is one a recording may be attached to.
 *
 * "A meeting" is derived (`isMeetingLead`), so this asks the same question the
 * Meetings view asks rather than a copy of it: interested, or a date in the
 * diary. Attaching a call recording to a lead nobody has spoken to is a sign
 * the id came from somewhere other than the agenda.
 */
async function requireMeeting(leadId: string): Promise<void> {
  const row = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!row) {
    throw new RecordingError("not_found", "No meeting with that id.", 404);
  }
  if (!isMeetingLead(toLead(row))) {
    throw new RecordingError(
      "not_a_meeting",
      "That lead is not on the meetings agenda, so it cannot hold a call recording.",
      400,
    );
  }
}

/**
 * Store an upload against a meeting, replacing whatever was there.
 *
 * The order is bytes, then row, then delete-the-old — and each step is that way
 * for a reason:
 *
 *   Bytes first, because a row pointing at a file that failed to write is a
 *   broken player for every viewer, while a file with no row is invisible and
 *   sweepable.
 *
 *   The row is an upsert on the unique `leadId`, so a replace is one statement
 *   and two uploads racing on the same meeting end with one winner and one
 *   orphaned object rather than two rows.
 *
 *   The previous object is deleted last, once the row that used to reference it
 *   no longer does. Deleting it first would mean a failure in between leaves a
 *   row whose audio is already gone.
 */
export async function saveRecording(params: {
  leadId: string;
  user: SessionUser;
  fileName: string;
  declaredType: string;
  bytes: Uint8Array;
  durationSeconds: number | null;
}): Promise<RecordingSummary> {
  const { leadId, user, bytes } = params;

  await requireMeeting(leadId);

  const existing = await prisma.meetingRecording.findUnique({
    where: { leadId },
    select: { id: true, uploadedById: true, storageKey: true },
  });

  // Replacing someone else's recording is the same act as deleting it, and is
  // refused on the same rule. Checked before the file is written so a rejected
  // upload leaves nothing behind.
  if (existing && !canManageRecording(user, existing)) {
    throw new RecordingError(
      "forbidden",
      "That meeting already has a recording uploaded by someone else.",
      403,
    );
  }

  const fileType = validateUpload(params.fileName, params.declaredType, bytes);
  const storageKey = newStorageKey(fileType);
  const fileSize = await putRecording(storageKey, bytes);

  // The stored filename is a label shown back to the uploader, so it is capped
  // and stripped of path separators — it never reaches the filesystem (the key
  // is server-generated), but it does reach a DOM.
  const fileName = params.fileName.replace(/[\\/]/g, "_").slice(0, 200) || "recording";

  try {
    const row = await prisma.meetingRecording.upsert({
      where: { leadId },
      create: {
        leadId,
        uploadedById: user.id,
        fileName,
        fileType,
        fileSize,
        storageKey,
        durationSeconds: params.durationSeconds,
      },
      update: {
        // Ownership moves to whoever uploaded the file that is actually there.
        // Leaving the original uploader on a replaced recording would credit a
        // call to someone who did not upload it, and — since ownership is the
        // authorization subject — could hand an agent control of a recording an
        // admin replaced.
        uploadedById: user.id,
        fileName,
        fileType,
        fileSize,
        storageKey,
        durationSeconds: params.durationSeconds,
      },
      select: RECORDING_SELECT,
    });

    if (existing && existing.storageKey !== storageKey) {
      await deleteRecording(existing.storageKey).catch((error) => {
        // The replacement is saved and correct; the stale object is a disk
        // matter, not a user-facing failure.
        console.error(`Could not delete replaced recording ${existing.storageKey}:`, error);
      });
    }

    return toSummary(row, user);
  } catch (error) {
    // The row did not land, so nothing references these bytes. Remove them
    // rather than leaving an unreferenced object behind.
    await deleteRecording(storageKey).catch(() => {});
    throw error;
  }
}

/**
 * Remove a recording, row and bytes.
 *
 * Row first: while the row exists the audio is reachable, and the row is what
 * every authorization check reads. If the unlink then fails, the file is
 * unreferenced and unreachable — bad housekeeping, not a data leak. The other
 * order would leave a live row whose playback 500s.
 */
export async function removeRecording(leadId: string, user: SessionUser): Promise<boolean> {
  const row = await prisma.meetingRecording.findUnique({
    where: { leadId },
    select: { id: true, uploadedById: true, storageKey: true },
  });

  // Same 404 for "no recording" and "not yours to see", so the endpoint cannot
  // be used to discover which meetings other agents have recorded.
  if (!row || !canAccessRecording(user, row)) return false;

  if (!canManageRecording(user, row)) {
    throw new RecordingError(
      "forbidden",
      "You can only delete recordings you uploaded.",
      403,
    );
  }

  await prisma.meetingRecording.delete({ where: { id: row.id } });
  await deleteRecording(row.storageKey).catch((error) => {
    console.error(`Could not delete recording object ${row.storageKey}:`, error);
  });

  return true;
}
