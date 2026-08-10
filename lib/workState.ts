/**
 * New vs Called — the worklist's top-level split.
 *
 * A lead is **New** until an agent saves a call outcome against it, and
 * **Called** from that moment on, for good. That is the whole rule, and it is
 * one column in Postgres (`leads.first_called_at`, see schema.prisma): null is
 * New, non-null is Called. Nothing about it lives in React state, so a reload,
 * a second agent or a different browser all see the same answer.
 *
 * **Not a status.** The eight `CallStatus` values say where a lead stands now;
 * this says whether it has been picked up at all. They are orthogonal on
 * purpose — a lead is Called + Interested, or Called + No answer, and all of
 * them stay Called because all of them were worked. `isCalled(status)` is the
 * *old* approximation of this question and still drives the headline "called"
 * figure; it is deliberately not what the tabs read, because a status can be
 * corrected back to `not_called` and a lead that has actually been dialled must
 * not return to the New queue for someone to dial again.
 *
 * Kept apart from `lib/views.ts` for the same reason it is a separate control
 * on screen: the four views there are *scopes* over a queue ("what do I owe a
 * callback on"), and this chooses *which queue* — the tabs and the views
 * compose rather than compete.
 *
 * No Prisma and no React here: imported by a client component, a server
 * component and a route handler alike.
 */
export const LEAD_WORK_STATES = ["new", "called"] as const;

export type LeadWorkState = (typeof LEAD_WORK_STATES)[number];

/**
 * New, not Called.
 *
 * An agent opening the portal is there to work the leads nobody has touched;
 * the ones already called are a record they go looking for. Defaulting the
 * other way put the day's work behind a click.
 */
export const DEFAULT_WORK_STATE: LeadWorkState = "new";

export const LEAD_WORK_STATE_LABELS: Record<LeadWorkState, string> = {
  new: "New",
  called: "Called",
};

/** Shown beside the control so the current queue is never ambiguous. */
export const LEAD_WORK_STATE_HINTS: Record<LeadWorkState, string> = {
  new: "Never called — work these top to bottom.",
  called: "Worked at least once, most recently worked first.",
};

/**
 * How many leads sit in each queue. Every lead is in exactly one, so the two
 * always add up to the size of the table.
 *
 * Declared here rather than next to the query that produces it (`leadWorkCounts`
 * in `lib/leadDb.ts`) so the client component drawing the badges can name the
 * shape without importing a module that constructs a Prisma client.
 */
export type LeadWorkCounts = Record<LeadWorkState, number>;
