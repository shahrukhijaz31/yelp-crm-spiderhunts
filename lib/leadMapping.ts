// Prisma 7 exports model row types with a `Model` suffix (`LeadModel`), which
// leaves the name `Lead` free for the app's own type below.
import type { LeadModel as LeadRow } from "./generated/prisma/models";
import { isCalled, type Lead } from "./types";

/**
 * The boundary between Postgres rows and the app's `Lead` type.
 *
 * Pure functions only — no Prisma Client, no connection. That is what lets the
 * seed script import it before `dotenv` has run (ES module imports are
 * evaluated before any statement in the importing file, so pulling in
 * `lib/prisma.ts` there would construct a client against an unset
 * `DATABASE_URL`). `lib/leadDb.ts` holds everything that actually queries.
 *
 * Everything above this file — components, filters, export, stats — keeps
 * working against `lib/types.ts` exactly as it did when the data came from
 * `getMockLeads()`. Only these two functions know the row shape, so the one
 * place the database representation genuinely differs from the UI's is handled
 * once, here: dates.
 *
 * `callback_date` and `meeting_completed_at` are Postgres `DATE` columns, which
 * the driver hands back as a `Date` pinned to UTC midnight. The UI works in
 * plain `YYYY-MM-DD` strings and compares them with `<`, so they are converted
 * with the *UTC* accessors. The local ones would shift the date by a day for
 * anyone west of Greenwich: a callback set for the 7th would render, and sort,
 * as the 6th.
 */

/** `Date` (UTC midnight) -> `YYYY-MM-DD`, or null. */
export function toIsoDate(value: Date | null): string | null {
  if (!value) return null;
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** `YYYY-MM-DD` -> `Date` at UTC midnight, the inverse of {@link toIsoDate}. */
export function fromIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One database row as the rest of the app expects to see it. */
export function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    categories: row.categories,
    phone: row.phone,
    website: row.website,
    rating: row.rating,
    owner: row.owner,
    url: row.url,
    source: row.source,
    status: row.status,
    notes: row.notes,
    callbackDate: toIsoDate(row.callbackDate),
    meetingTime: row.meetingTime,
    meetingAttendees: row.meetingAttendees,
    meetingNotes: row.meetingNotes,
    meetingCompletedAt: toIsoDate(row.meetingCompletedAt),
  };
}

/**
 * A parsed lead as an insert payload.
 *
 * `id` is dropped on purpose: ids coming out of `parseLeadsCsv` are row-index
 * placeholders (`sample-leads-3`), unique only within one file. Letting the
 * database mint the cuid means an id is unique across every import, which is
 * what makes it safe to reference from an export.
 */
export function toCreateData(lead: Lead, sourceBatch: string | null) {
  return {
    name: lead.name,
    address: lead.address,
    categories: lead.categories,
    phone: lead.phone,
    website: lead.website,
    rating: lead.rating,
    owner: lead.owner,
    url: lead.url,
    source: lead.source,
    status: lead.status,
    /*
     * A row arriving already carrying an outcome has, by definition, been
     * worked — so it belongs in Called rather than in the queue of leads nobody
     * has rung. This is the same rule the backfill migration applied to the
     * rows that were already in the table, kept here so a re-import or a demo
     * seed cannot put a called lead back in front of an agent to call again.
     *
     * In practice this is null for every scraped row: `parseLeadsCsv` and the
     * ingest endpoint both write `not_called`, so the only leads it stamps are
     * the ones some source deliberately said were already handled.
     */
    firstCalledAt: isCalled(lead.status) ? new Date() : null,
    notes: lead.notes,
    callbackDate: fromIsoDate(lead.callbackDate),
    meetingTime: lead.meetingTime,
    meetingAttendees: lead.meetingAttendees,
    meetingNotes: lead.meetingNotes,
    meetingCompletedAt: fromIsoDate(lead.meetingCompletedAt),
    sourceBatch,
  };
}
