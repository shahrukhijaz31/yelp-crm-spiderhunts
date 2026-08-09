/**
 * Single source of truth for the lead data shape.
 * Used by the mock data, the CSV parser, the API routes and every UI component.
 * When a real database is added, this is the type its rows should map onto.
 */

export const CALL_STATUSES = [
  "not_called",
  "no_answer",
  "voicemail",
  // Someone picked up, but not the person who can say yes. Kept next to the
  // other "reached nobody useful" outcomes rather than at the end of the list,
  // because that is the order an agent works down the dropdown in — and the
  // Postgres enum is declared in this same order, so the two never disagree.
  "owner_not_available",
  "interested",
  "not_interested",
  "do_not_call",
  "bad_number",
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  not_called: "Not called",
  no_answer: "Called - No answer",
  voicemail: "Called - Voicemail",
  owner_not_available: "Called - Owner not available",
  interested: "Called - Interested",
  not_interested: "Called - Not interested",
  do_not_call: "Do not call",
  bad_number: "Bad number",
};

/** Short label used inside the compact row badge. */
export const CALL_STATUS_SHORT_LABELS: Record<CallStatus, string> = {
  not_called: "Not called",
  no_answer: "No answer",
  voicemail: "Voicemail",
  // Shortened to fit the row chip beside its dot and chevron, where the full
  // "Owner not available" would truncate at the width the Status column has.
  owner_not_available: "Owner away",
  interested: "Interested",
  not_interested: "Not interested",
  do_not_call: "Do not call",
  bad_number: "Bad number",
};

/**
 * Status colour lives here and nowhere else.
 *
 * Seven hues that stay apart from each other *and* from the app's red accent,
 * which is reserved for the primary action, the active view and anything
 * time-critical. A status is never red, so a status can never be mistaken for
 * "this one is urgent".
 *
 * Each entry is a border/background/text triple worn by `.chip` (see
 * `globals.css`), and the chip's dot inherits `currentColor` — so a status is
 * one colour decision made here, not four scattered across the components that
 * draw it.
 *
 * `do_not_call` is the odd one out on purpose: the only fully inverted chip in
 * the app, because it is the only hard stop.
 */
export const CALL_STATUS_STYLES: Record<CallStatus, string> = {
  not_called: "border-line-2 bg-transparent text-st-neutral",
  no_answer: "border-st-gold-line bg-st-gold-bg text-st-gold",
  voicemail: "border-st-sky-line bg-st-sky-bg text-st-sky",
  owner_not_available: "border-st-teal-line bg-st-teal-bg text-st-teal",
  interested: "border-st-green-line bg-st-green-bg text-st-green",
  not_interested: "border-st-orchid-line bg-st-orchid-bg text-st-orchid",
  do_not_call: "border-fg bg-fg text-on-invert",
  bad_number: "border-st-steel-line bg-st-steel-bg text-st-steel",
};

/** Solid dot colour used in chips, the stacked bar and the stat legend. */
export const CALL_STATUS_DOTS: Record<CallStatus, string> = {
  not_called: "bg-fg-4",
  no_answer: "bg-st-gold",
  voicemail: "bg-st-sky",
  owner_not_available: "bg-st-teal",
  interested: "bg-st-green",
  not_interested: "bg-st-orchid",
  do_not_call: "bg-fg",
  bad_number: "bg-st-steel",
};

/** A status other than `not_called` means the lead has been worked. */
export function isCalled(status: CallStatus): boolean {
  return status !== "not_called";
}

/**
 * A lead as shown in the portal.
 *
 * The scraper-sourced fields (name .. url) mirror the CSV columns exactly.
 * The agent-owned fields (status, notes, callbackDate) are added by this app
 * and are what a future PATCH /api/leads/:id endpoint would persist.
 */
export interface Lead {
  /** Stable client-side id. A real backend would supply its own primary key. */
  id: string;

  // --- Scraped fields (match the scraper CSV columns) ---
  name: string;
  address: string;
  /** Raw `categories` column, kept as a list. */
  categories: string[];
  phone: string | null;
  website: string | null;
  rating: number | null;
  owner: string | null;
  /** Yelp listing URL. */
  url: string | null;

  // --- Agent-owned fields ---
  status: CallStatus;
  notes: string;
  /** ISO `YYYY-MM-DD`, or null when no callback is scheduled. */
  callbackDate: string | null;

  /*
   * Meeting detail, layered on top of `callbackDate` rather than stored apart.
   * Membership of the Meetings view is *derived* (see `lib/meetings.ts`), so a
   * lead moved to "Interested" appears there with no extra bookkeeping, and
   * these fields simply fill in once someone books a time.
   */
  /** 24-hour `HH:MM`, or null when only a date is set. */
  meetingTime: string | null;
  /** Free text: who is joining, and in what capacity. */
  meetingAttendees: string | null;
  /** Kept apart from `notes` so call notes are never overwritten by agenda notes. */
  meetingNotes: string;
  /** ISO `YYYY-MM-DD` the meeting was marked done, or null while it is open. */
  meetingCompletedAt: string | null;
}

/** The subset of a lead an agent can edit from the list view. */
export type LeadEditableFields = Pick<
  Lead,
  | "status"
  | "notes"
  | "callbackDate"
  | "meetingTime"
  | "meetingAttendees"
  | "meetingNotes"
  | "meetingCompletedAt"
>;
