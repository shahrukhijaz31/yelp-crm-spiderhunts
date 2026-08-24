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
 * Which directory a lead was scraped out of.
 *
 * The portal started as a front end for one Yelp scraper, so "where did this
 * come from" had one answer and was never recorded. A second scraper now reads
 * Google Maps and pushes into the same table, and the two sources are not
 * interchangeable to the person on the phone: Google usually has the number and
 * the opening hours, Yelp usually has the owner's name and a longer review
 * history, and a 4.2 means a different thing on each. So an agent needs to know
 * which listing they are looking at before they dial, and a manager needs to be
 * able to ask "how are the Google leads converting" — which is a filter, not a
 * hunt through `sourceBatch` strings.
 *
 * A closed set, mirrored by the `lead_source` Postgres enum. Adding a third
 * directory means adding it here, in the schema and in a migration together —
 * which is the point: nothing in the app has to guess what an unknown source
 * should look like, because there cannot be one.
 */
export const LEAD_SOURCES = ["yelp", "google"] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * What a lead arriving without a source is. The Yelp scraper predates the
 * column and does not send it, so this is the true value for its rows rather
 * than a placeholder — the same default the database column carries.
 */
export const DEFAULT_LEAD_SOURCE: LeadSource = "yelp";

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  yelp: "Yelp",
  google: "Google Maps",
};

/** Room is tight in the row badge and the filter chip, so: one word each. */
export const LEAD_SOURCE_SHORT_LABELS: Record<LeadSource, string> = {
  yelp: "Yelp",
  google: "Google",
};

/**
 * Source colour, kept here beside the status colours and chosen against them.
 *
 * Deliberately *not* the two brands' own colours. Yelp's red is the accent this
 * app reserves for the primary action and anything time-critical, so a Yelp
 * badge in Yelp red would read as "this lead is urgent"; and a status is never
 * red for exactly that reason. Google's four-colour mark cannot be a chip at
 * all.
 *
 * They are their own pair of hues (`--c-src-*` in `globals.css`) rather than
 * two borrowed from the status palette, because a source badge and a status
 * chip sit two columns apart in the same row: sharing a hue would make them
 * look like the same kind of fact. Same border/background/text triple, worn by
 * the same `.chip`.
 */
export const LEAD_SOURCE_STYLES: Record<LeadSource, string> = {
  yelp: "border-src-yelp-line bg-src-yelp-bg text-src-yelp",
  google: "border-src-google-line bg-src-google-bg text-src-google",
};

/** Solid dot colour, for the filter panel's list. */
export const LEAD_SOURCE_DOTS: Record<LeadSource, string> = {
  yelp: "bg-src-yelp",
  google: "bg-src-google",
};

/** A value from a CSV cell, a query string or a header as a source, or null. */
export function parseLeadSource(value: unknown): LeadSource | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  // The spellings a scraper, a spreadsheet or a hand-typed header actually
  // uses. Anything else is not silently mapped onto a source — the caller
  // falls back to its own default and says so.
  if (key === "yelp" || key === "yelp.com" || key === "yelp maps") return "yelp";
  if (
    key === "google" ||
    key === "google maps" ||
    key === "google_maps" ||
    key === "googlemaps" ||
    key === "gmaps" ||
    key === "maps"
  ) {
    return "google";
  }
  return null;
}

/**
 * The source a listing URL implies, or null when it implies nothing.
 *
 * The safety net under `parseLeadSource`: a Google Maps export that arrives
 * with no source column at all still has `https://www.google.com/maps/place/…`
 * in every row, and defaulting those to Yelp would mislabel a whole run. Host
 * matching only — the path is never inspected, so a Yelp page that happens to
 * link to Google does not flip a row.
 */
export function leadSourceFromUrl(url: string | null | undefined): LeadSource | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  const bare = host.replace(/^www\./, "");
  if (bare === "yelp.com" || bare.endsWith(".yelp.com")) return "yelp";
  if (bare === "google.com" || bare.endsWith(".google.com")) return "google";
  // `google.co.uk`, `google.de`, … — the Maps URL a scraper run outside the US
  // produces. `goo.gl` and `maps.app.goo.gl` short links too.
  if (/^google\.[a-z.]+$/.test(bare) || bare.endsWith("goo.gl")) return "google";
  return null;
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
  /** The listing URL on {@link Lead.source} — a Yelp biz page, or a Maps place. */
  url: string | null;
  /** Which directory the row was scraped out of. See {@link LEAD_SOURCES}. */
  source: LeadSource;

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
