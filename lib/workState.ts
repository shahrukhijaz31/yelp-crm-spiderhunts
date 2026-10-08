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
/**
 * `sms` is the odd one out: not a half of the New/Called split but a slice
 * across it. It holds every lead whose message status is SMS sent or WhatsApp
 * sent, whether or not anyone has rung it yet — so a texted lead that has not
 * been called is in New *and* SMS Sent, and stays in New until a call outcome
 * is saved, exactly as it would have without the message.
 */
export const LEAD_WORK_STATES = ["new", "called", "sms", "all"] as const;

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
  sms: "SMS Sent",
  all: "My leads",
};

/** Shown beside the control so the current queue is never ambiguous. */
export const LEAD_WORK_STATE_HINTS: Record<LeadWorkState, string> = {
  new: "Never called — work these top to bottom.",
  called: "Worked at least once, most recently worked first.",
  sms: "Sent an SMS or WhatsApp, called or not — most recently worked first.",
  all: "Every lead you added, called or not — most recently worked first.",
};

/**
 * Which queues a role works from.
 *
 * Agents and administrators split the shared pool three ways. A contributor's
 * list is the handful of leads they added themselves, so it is one queue —
 * `all` — and a lead they call stays in front of them instead of moving to a
 * Called queue they are not given. The worklist never offers a queue outside
 * this list; the server would answer one (`all` over a contributor's scope is
 * still their own leads), so this is about what is drawn, not who may read.
 */
export function queuesFor(role: string): readonly LeadWorkState[] {
  return role === "CONTRIBUTOR" ? CONTRIBUTOR_QUEUES : POOL_QUEUES;
}

export const POOL_QUEUES: readonly LeadWorkState[] = ["new", "called", "sms"];
const CONTRIBUTOR_QUEUES: readonly LeadWorkState[] = ["all"];

/** The queue a role's worklist opens on: the first one it is given. */
export function defaultWorkStateFor(role: string): LeadWorkState {
  return queuesFor(role)[0];
}

/**
 * How many leads sit in each queue. Every lead is in exactly one of New and
 * Called, so those two add up to the size of the table; SMS Sent overlaps both
 * and is not part of that sum.
 *
 * Declared here rather than next to the query that produces it (`leadWorkCounts`
 * in `lib/leadDb.ts`) so the client component drawing the badges can name the
 * shape without importing a module that constructs a Prisma client.
 */
export type LeadWorkCounts = Record<LeadWorkState, number>;
