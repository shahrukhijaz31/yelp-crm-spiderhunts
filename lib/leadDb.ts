import { identityKeys } from "./cleanLeads";
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

/*
 * `replaceAllLeads` used to live here — deleteMany + createMany in one
 * transaction, called by the CSV upload. It was correct while the worklist was
 * React state that a reload discarded anyway, and actively dangerous once the
 * table held real call history: a second import destroyed every status, note
 * and callback the agents had entered.
 *
 * Both write paths now merge. It is deleted rather than left unused because an
 * exported `deleteMany({})` on the leads table is the kind of function that
 * gets wired back up by someone who only reads its name. Emptying the table on
 * purpose is a database operation — see deploy/README.md.
 */

export interface MergeLeadsResult {
  /** Rows written to the table. */
  inserted: number;
  /** Rows already present (same phone, or same name at the same address). */
  skippedExisting: number;
}

/**
 * Postgres caps a statement at 65535 bound parameters and `createMany` sends
 * one INSERT; at ~16 columns a row that is ~4000 rows. 1000 keeps a wide margin
 * and still means a 40k-row scrape is 40 statements, not 40k.
 */
const INSERT_CHUNK = 1000;

/**
 * Add scraped leads to the worklist without disturbing what is already there.
 *
 * Used by both write paths: the scraper's `POST /api/leads/ingest`, which runs
 * on a schedule and would otherwise wipe an agent's work on every run, and the
 * CSV upload, which had the same problem the second time anyone used it.
 *
 * A business already in the table is left completely untouched — including its
 * scraped fields, so neither a re-scrape nor a re-upload can overwrite an
 * address an agent has since corrected by hand.
 *
 * Duplicate matching uses `identityKeys`, the same rule `cleanLeads` applies
 * within a single file, so "already have it" means the same thing at both ends.
 *
 * Not transactional across the read and the write: two ingests running at the
 * same instant could both decide a lead is new and insert it twice. The scraper
 * pushes serially and there is no unique constraint on phone by design (see
 * schema.prisma), so this is left as-is rather than paid for with a serializable
 * transaction on every import.
 */
export async function mergeLeads(
  incoming: Lead[],
  sourceBatch: string | null,
): Promise<MergeLeadsResult> {
  // Only the three identity columns are read: pulling whole rows would mean
  // dragging every note and meeting field over the wire to answer a set
  // membership question.
  const existing = await prisma.lead.findMany({
    select: { name: true, address: true, phone: true },
  });

  const seen = new Set(existing.flatMap(identityKeys));

  const fresh: Lead[] = [];
  let skippedExisting = 0;

  for (const lead of incoming) {
    const keys = identityKeys(lead);
    if (keys.some((key) => seen.has(key))) {
      skippedExisting += 1;
      continue;
    }
    // Added as we go, so a batch containing the same business twice inserts it
    // once even when neither copy was in the table to begin with.
    for (const key of keys) seen.add(key);
    fresh.push(lead);
  }

  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    await prisma.lead.createMany({
      data: fresh.slice(i, i + INSERT_CHUNK).map((lead) => toCreateData(lead, sourceBatch)),
    });
  }

  return { inserted: fresh.length, skippedExisting };
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
