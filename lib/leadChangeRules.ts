import {
  CALL_STATUS_LABELS,
  LEAD_SOURCE_LABELS,
  MESSAGE_STATUS_LABELS,
  type CallStatus,
  type Lead,
  type LeadDetailFields,
  type LeadEditableFields,
  type LeadSource,
  type MessageStatus,
} from "./types";

/**
 * The vocabulary of a lead's change history, shared by the server that writes
 * it and the Activity panel that reads it.
 *
 * Pure — no Prisma — so the client can import the labels and the formatter.
 * The writing lives in `lib/leadChanges.ts`.
 */

/** Every field whose edits are recorded, in the order a save lists them. */
export const LEAD_CHANGE_FIELDS = [
  "name",
  "phone",
  "website",
  "address",
  "source",
  "url",
  "status",
  "messageStatus",
  "onWhatsapp",
  "notes",
  "callbackDate",
  "meetingTime",
  "meetingAttendees",
  "meetingNotes",
  "meetingCompletedAt",
] as const satisfies readonly (keyof (LeadEditableFields & LeadDetailFields))[];

export type LeadChangeField = (typeof LEAD_CHANGE_FIELDS)[number];

/** The row written once, when a lead is added by hand. Not a field. */
export const LEAD_CREATED = "created";

export const LEAD_CHANGE_LABELS: Record<LeadChangeField, string> = {
  name: "Name",
  phone: "Phone",
  website: "Website",
  address: "Address",
  source: "Source",
  url: "Source link",
  status: "Status",
  messageStatus: "Message status",
  onWhatsapp: "On WhatsApp",
  notes: "Call notes",
  callbackDate: "Meeting date",
  meetingTime: "Meeting time",
  meetingAttendees: "Meeting attendees",
  meetingNotes: "Meeting notes",
  meetingCompletedAt: "Meeting completed",
};

/** Free text, where the panel shows the whole new value rather than a from → to. */
export const LONG_TEXT_FIELDS: ReadonlySet<LeadChangeField> = new Set([
  "notes",
  "meetingNotes",
]);

/** One recorded change, as it travels to the browser. */
export interface LeadChangeEntry {
  id: string;
  /** A {@link LeadChangeField}, or {@link LEAD_CREATED}. */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** ISO instant — the browser formats it in the reader's own timezone. */
  at: string;
  /** Who saved it; null for a write with no person behind it. */
  by: { id: string; name: string } | null;
}

/**
 * A field's value as stored in the history: the enum key, `YYYY-MM-DD`,
 * `HH:MM`, `true`/`false`, or the text. Empty strings are stored as null, so
 * "cleared" reads the same whatever the column's own idea of empty is.
 */
export function toChangeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return text === "" ? null : text;
}

/**
 * The fields that differ between two versions of a lead, as history rows.
 * Compared on the stored form, so `""` → `null` is not a change.
 */
export function diffLead(
  before: Lead,
  after: Lead,
): Array<{ field: LeadChangeField; oldValue: string | null; newValue: string | null }> {
  const changes = [];
  for (const field of LEAD_CHANGE_FIELDS) {
    const oldValue = toChangeValue(before[field]);
    const newValue = toChangeValue(after[field]);
    if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
  }
  return changes;
}

/** A stored value as the panel shows it. Null comes back as null ("empty"). */
export function formatChangeValue(field: string, value: string | null): string | null {
  if (value === null) return null;
  switch (field) {
    case "status":
      return CALL_STATUS_LABELS[value as CallStatus] ?? value;
    case "messageStatus":
      return MESSAGE_STATUS_LABELS[value as MessageStatus] ?? value;
    case "source":
      return LEAD_SOURCE_LABELS[value as LeadSource] ?? value;
    case "onWhatsapp":
      return value === "true" ? "Yes" : value === "false" ? "No" : value;
    default:
      return value;
  }
}

export function changeLabel(field: string): string {
  return field === LEAD_CREATED
    ? "Lead added"
    : (LEAD_CHANGE_LABELS[field as LeadChangeField] ?? field);
}
