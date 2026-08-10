import {
  buildLeadSearchParams,
  DEFAULT_PAGE_SIZE,
  type LeadPageQuery,
} from "./leadQuery";

/**
 * The address of a lead's workspace, and the context it carries with it.
 *
 * A lead opens in its own browser tab, which means the new tab starts with
 * nothing: no React state, no memory of the queue it came from, no idea which
 * filters were applied. Everything the workspace needs to behave like a
 * continuation of the list rather than an isolated record has to survive the
 * trip in the URL — and the URL is the right place for it, because the tab has
 * to work when it is bookmarked, reloaded or opened by hand.
 *
 * The context is written with `buildLeadSearchParams`, the *same* function the
 * worklist uses to ask `GET /api/leads` for a page, and read back with
 * `parseLeadSearchParams`. So "the list this lead came from" is described in
 * exactly one vocabulary, and Next lead resolves against the query the agent
 * was actually looking at rather than a second approximation of it.
 *
 * One parameter is added on top of that vocabulary — see
 * {@link LEAD_POSITION_PARAM}.
 *
 * No Prisma and no React: imported by a client component, a server component
 * and (through `leadQuery`) the route handlers alike.
 */

/**
 * The current lead's 1-based ordinal within the filtered, sorted list.
 *
 * Belongs to the workspace rather than to the query, which is why it is not in
 * `buildLeadSearchParams`: it says *where in the answer* this lead was, not
 * what the question was. `nextLeadId` needs it because saving a call outcome
 * moves a lead out of the New queue, and a lead that is no longer in the set
 * cannot be located by id — but the ordinal it vacated still points at the row
 * that took its place.
 */
export const LEAD_POSITION_PARAM = "pos";

/** `/leads/<id>?<the list this lead came from>&pos=<where it was>`. */
export function leadWorkspaceHref(
  id: string,
  query: LeadPageQuery,
  position: number | null,
): string {
  const params = buildLeadSearchParams(query);
  if (position !== null) params.set(LEAD_POSITION_PARAM, String(position));
  return `/leads/${encodeURIComponent(id)}?${params}`;
}

/**
 * Where a row sits in the whole filtered list, not just on its page.
 *
 * Row 3 of page 4 at 20 per page is lead 63. The ordinal is over the result
 * set because that is what `nextLeadId` counts with — a per-page index would
 * walk back to the top of the page every twenty leads.
 */
export function leadPosition(page: number, pageSize: number, rowIndex: number): number {
  return (page - 1) * pageSize + rowIndex + 1;
}

/** A `pos` from a URL: 1-based, integral, or null when it is anything else. */
export function readLeadPosition(value: string | null | undefined): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

/**
 * Back to the worklist, on the page the agent left it on.
 *
 * Only the page and the size, because those are the only two the worklist
 * itself keeps in its address bar (see the note in `Worklist`) — sending it a
 * `view` or a `q` it does not read would be a promise the screen cannot keep.
 *
 * This is a link, not a "close tab" button. The leads tab is still open behind
 * this one; an agent who wants the list clicks it, and an agent who is done
 * closes the tab.
 */
export function leadsListHref(query: {
  page?: number;
  pageSize?: number;
}): string {
  const params = new URLSearchParams({
    page: String(Math.max(1, Math.floor(query.page ?? 1))),
    pageSize: String(query.pageSize ?? DEFAULT_PAGE_SIZE),
  });
  return `/?${params}`;
}
