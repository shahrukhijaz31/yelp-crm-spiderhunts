import { callbackState } from "./leadUtils";
import type { Lead } from "./types";
import type { LeadWorkState } from "./workState";

/**
 * The worklist's tabbed views. Each is a scope over the same dataset — an
 * agent switches between "what I'm working on now" rather than assembling it
 * from dropdowns. The filter rail then narrows *within* the chosen view.
 */
export const WORKLIST_VIEWS = ["all", "callback", "overdue", "issues"] as const;

export type WorklistView = (typeof WORKLIST_VIEWS)[number];

export const WORKLIST_VIEW_LABELS: Record<WorklistView, string> = {
  all: "All leads",
  callback: "Needs callback",
  overdue: "Overdue",
  issues: "Missing website",
};

/** Shown under the tabs so the current scope is never ambiguous. */
export const WORKLIST_VIEW_HINTS: Record<WorklistView, string> = {
  all: "Every lead in the list.",
  callback: "Callbacks scheduled for today, plus anything already past due.",
  overdue: "Callbacks whose date has passed — work these first.",
  issues: "No website on the listing — often the best fit for a first pitch.",
};

/**
 * The views a queue can actually answer.
 *
 * Both callback views read `callbackDate` and nothing else, and the New queue
 * has no callbacks worth a tab: a lead there has never been worked, so in
 * practice its callback column is empty and both tabs come back with nothing.
 * A tab that is always empty is not a scope, it is a dead end — and these two
 * were worse than empty, because the badges beside them are slices of a
 * workspace-wide aggregate (see `Worklist`) and so counted the Called queue's
 * callbacks while showing zero rows.
 *
 * `isInView` is deliberately left alone. It still answers honestly for any lead
 * handed to it, including the uncalled one that *can* carry a callback date —
 * `updateLead` treats a callback-only save as bookkeeping and leaves such a
 * lead in New. That lead is reachable under All leads, which is the right place
 * for a handful of rows; what it does not get is two permanent tabs.
 */
export function viewsFor(workState: LeadWorkState): readonly WorklistView[] {
  return workState === "new" ? NEW_QUEUE_VIEWS : WORKLIST_VIEWS;
}

const NEW_QUEUE_VIEWS = ["all", "issues"] as const satisfies readonly WorklistView[];

export function isInView(
  lead: Lead,
  view: WorklistView,
  today: string,
): boolean {
  switch (view) {
    case "callback": {
      const state = callbackState(lead, today);
      return state === "today" || state === "overdue";
    }
    case "overdue":
      return callbackState(lead, today) === "overdue";
    case "issues":
      // Phone and duplicate checks used to live here. `cleanLeads` now removes
      // those rows at ingest, leaving a missing website as the one gap an agent
      // can still act on.
      return !lead.website;
    case "all":
    default:
      return true;
  }
}

export function countInView(
  leads: Lead[],
  view: WorklistView,
  today: string,
): number {
  return leads.reduce(
    (total, lead) => total + (isInView(lead, view, today) ? 1 : 0),
    0,
  );
}