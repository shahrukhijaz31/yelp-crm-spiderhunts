import { EMPTY_FILTERS, type LeadFilters } from "@/lib/filters";
import { PAGE_SIZES, type LeadSection, type LeadSort, type PageSize } from "@/lib/leadQuery";
import { WORKLIST_VIEWS, type WorklistView } from "@/lib/views";
import { LEAD_WORK_STATES, type LeadWorkState } from "@/lib/workState";

/**
 * Where the worklist was, remembered per browser tab.
 *
 * The queue, the tab, the filters, the search, the sort and the page are client
 * state, so anything that reloads the screen used to lose them: Back from a
 * lead's own page, a refresh, or the browser unloading a background tab to save
 * memory. An agent working leads in six tabs came back to page 1 of an
 * unfiltered New queue every time.
 *
 * `sessionStorage`, not `localStorage` and not the database: it belongs to one
 * tab, so six tabs keep six places without overwriting each other, it survives
 * a reload of that tab, and it is gone when the tab is closed — which is when a
 * remembered search stops being helpful and starts being a surprise.
 *
 * Nothing here is trusted. The values are only ever sent back to
 * `GET /api/leads`, which validates every one of them, and anything unreadable
 * is treated as nothing remembered rather than an error.
 */
export interface WorklistPlace {
  workState: LeadWorkState;
  view: WorklistView;
  filters: LeadFilters;
  sort: LeadSort;
  page: number;
  pageSize: PageSize;
}

const VERSION = 1;

function storageKey(section: LeadSection): string {
  return `worklist:${section}`;
}

export function saveWorklistPlace(section: LeadSection, place: WorklistPlace): void {
  try {
    window.sessionStorage.setItem(storageKey(section), JSON.stringify({ v: VERSION, ...place }));
  } catch {
    // Storage full or blocked (private mode, a locked-down browser). The screen
    // works exactly as it did before this existed.
  }
}

export function loadWorklistPlace(section: LeadSection): WorklistPlace | null {
  let raw: unknown;
  try {
    const text = window.sessionStorage.getItem(storageKey(section));
    if (!text) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const saved = raw as Record<string, unknown>;
  if (saved.v !== VERSION) return null;

  const { workState, view, filters, sort, page, pageSize } = saved;
  if (!(LEAD_WORK_STATES as readonly unknown[]).includes(workState)) return null;
  if (!(WORKLIST_VIEWS as readonly unknown[]).includes(view)) return null;
  if (!(PAGE_SIZES as readonly unknown[]).includes(pageSize)) return null;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  if (
    typeof sort !== "object" ||
    sort === null ||
    typeof (sort as LeadSort).key !== "string" ||
    typeof (sort as LeadSort).direction !== "string"
  ) {
    return null;
  }
  if (typeof filters !== "object" || filters === null) return null;

  return {
    workState: workState as LeadWorkState,
    view: view as WorklistView,
    filters: mergeFilters(filters as Record<string, unknown>),
    sort: { key: (sort as LeadSort).key, direction: (sort as LeadSort).direction },
    page,
    pageSize: pageSize as PageSize,
  };
}

/**
 * The saved filters laid over the empty ones, field by field.
 *
 * Built from `EMPTY_FILTERS` so a field added after the place was saved gets
 * its default, a field since removed is dropped, and a value of the wrong kind
 * (an array where a string belongs) falls back rather than reaching the query.
 */
function mergeFilters(saved: Record<string, unknown>): LeadFilters {
  const merged: Record<string, unknown> = { ...EMPTY_FILTERS };
  for (const [key, empty] of Object.entries(EMPTY_FILTERS)) {
    const value = saved[key];
    if (value === undefined) continue;
    const sameKind =
      Array.isArray(empty)
        ? Array.isArray(value)
        : empty === null
          ? value === null || typeof value === "string"
          : typeof value === typeof empty;
    if (sameKind) merged[key] = value;
  }
  return merged as unknown as LeadFilters;
}
