import { fromIsoDate, toCreateData, toLead } from "./leadMapping";
import { prisma } from "./prisma";
import { CALL_STATUSES, type CallStatus, type Lead, type LeadEditableFields } from "./types";

/**
 * Every database query the app makes.
 *
 * Row <-> `Lead` conversion lives next door in `lib/leadMapping.ts` (pure, no
 * client), so this file is only the queries and the validation guarding them.
 */

/**
 * Every lead, in a stable order.
 *
 * Ordered by insertion so a CSV keeps the order it was uploaded in — the
 * worklist is worked top to bottom, and rows that shuffle between page loads
 * are disorienting. `id` breaks ties, because `created_at` has millisecond
 * resolution and a `createMany` writes a whole file inside one millisecond.
 */
export async function listLeads(): Promise<Lead[]> {
  const rows = await prisma.lead.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toLead);
}

/** Apply an agent's inline edit. Returns the saved row, or null if it is gone. */
export async function updateLeadFields(
  id: string,
  changes: Partial<LeadEditableFields>,
): Promise<Lead | null> {
  // Only the keys actually present are written, so a PATCH carrying just
  // `{ status }` cannot blank out someone's notes.
  const data: Record<string, unknown> = {};
  if ("status" in changes) data.status = changes.status;
  if ("notes" in changes) data.notes = changes.notes;
  if ("callbackDate" in changes) data.callbackDate = fromIsoDate(changes.callbackDate ?? null);
  if ("meetingTime" in changes) data.meetingTime = changes.meetingTime;
  if ("meetingAttendees" in changes) data.meetingAttendees = changes.meetingAttendees;
  if ("meetingNotes" in changes) data.meetingNotes = changes.meetingNotes;
  if ("meetingCompletedAt" in changes) {
    data.meetingCompletedAt = fromIsoDate(changes.meetingCompletedAt ?? null);
  }

  if (Object.keys(data).length === 0) {
    const existing = await prisma.lead.findUnique({ where: { id } });
    return existing ? toLead(existing) : null;
  }

  const row = await prisma.lead.findUnique({ where: { id } });
  if (!row) return null;

  return toLead(await prisma.lead.update({ where: { id }, data }));
}

/**
 * Swap the whole table for a freshly imported file.
 *
 * This mirrors what the Import view already did in memory — a CSV *replaces*
 * the worklist rather than merging into it. Wrapped in a transaction so a
 * failure part-way through cannot leave the table empty: either the new file
 * is in, or the old data is still there.
 */
export async function replaceAllLeads(
  leads: Lead[],
  sourceBatch: string | null,
): Promise<Lead[]> {
  await prisma.$transaction([
    prisma.lead.deleteMany({}),
    prisma.lead.createMany({ data: leads.map((lead) => toCreateData(lead, sourceBatch)) }),
  ]);

  return listLeads();
}

/** Runtime guard for the `status` field arriving over the wire. */
function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === "string" && (CALL_STATUSES as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` and nothing else — this string reaches a date column. */
function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 24-hour `HH:MM`, matching what the meeting time input produces. */
function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export class LeadEditError extends Error {}

/**
 * Validate a PATCH body into the subset of fields an agent may edit.
 *
 * Deliberately strict rather than forgiving: a malformed date silently coerced
 * to null would look like the agent cleared a callback they had just set, and
 * they would have no way to tell. Unknown keys are ignored, which is what keeps
 * the scraped fields read-only from this endpoint.
 */
export function parseLeadEdits(body: unknown): Partial<LeadEditableFields> {
  if (typeof body !== "object" || body === null) {
    throw new LeadEditError("Expected a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const edits: Partial<LeadEditableFields> = {};

  if ("status" in input) {
    if (!isCallStatus(input.status)) {
      throw new LeadEditError(`Unknown status: ${JSON.stringify(input.status)}.`);
    }
    edits.status = input.status;
  }

  for (const key of ["notes", "meetingNotes"] as const) {
    if (key in input) {
      if (typeof input[key] !== "string") throw new LeadEditError(`${key} must be a string.`);
      edits[key] = input[key];
    }
  }

  for (const key of ["callbackDate", "meetingCompletedAt"] as const) {
    if (key in input) {
      if (input[key] !== null && !isIsoDate(input[key])) {
        throw new LeadEditError(`${key} must be YYYY-MM-DD or null.`);
      }
      edits[key] = input[key] as string | null;
    }
  }

  if ("meetingTime" in input) {
    if (input.meetingTime !== null && !isClockTime(input.meetingTime)) {
      throw new LeadEditError("meetingTime must be HH:MM or null.");
    }
    edits.meetingTime = input.meetingTime as string | null;
  }

  if ("meetingAttendees" in input) {
    if (input.meetingAttendees !== null && typeof input.meetingAttendees !== "string") {
      throw new LeadEditError("meetingAttendees must be a string or null.");
    }
    edits.meetingAttendees = input.meetingAttendees as string | null;
  }

  return edits;
}
