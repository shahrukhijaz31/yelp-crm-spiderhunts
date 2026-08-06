import { callbackState, normalisePhone, todayIso } from "./leadUtils";
import { CALL_STATUS_LABELS, type CallStatus, type Lead } from "./types";

/**
 * The filter model, kept out of the components on purpose.
 *
 * `matchesFilters` is a pure predicate over a single lead, so the same rules
 * can later run in a database query or an API route without being untangled
 * from React first.
 */

export type CallbackRange =
  | "all"
  | "today"
  | "week"
  | "overdue"
  | "any"
  | "none"
  | "custom";

export const CALLBACK_RANGE_LABELS: Record<CallbackRange, string> = {
  all: "Any callback state",
  today: "Due today",
  week: "Due this week",
  overdue: "Overdue",
  any: "Has a callback date",
  none: "No callback date",
  custom: "Custom date range",
};

export interface LeadFilters {
  /** Free text over name, address, phone, notes and owner. */
  query: string;
  /** Empty means "all statuses" rather than "none". */
  statuses: CallStatus[];
  /** Empty means "all categories". A lead matches if it has *any* of these. */
  categories: string[];
  ratingMin: number | null;
  ratingMax: number | null;
  callback: CallbackRange;
  /** Inclusive ISO bounds, only read when `callback` is `custom`. */
  callbackFrom: string | null;
  callbackTo: string | null;
}

export const EMPTY_FILTERS: LeadFilters = {
  query: "",
  statuses: [],
  categories: [],
  ratingMin: null,
  ratingMax: null,
  callback: "all",
  callbackFrom: null,
  callbackTo: null,
};

/** Selectable rating steps, matching the half-star values Yelp reports. */
export const RATING_STEPS = [3, 3.5, 4, 4.5, 5] as const;

// --- category options -------------------------------------------------------

export interface CategoryOption {
  name: string;
  count: number;
}

/** Every distinct category in the list, most common first. */
export function collectCategories(leads: Lead[]): CategoryOption[] {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    for (const category of lead.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

// --- matching ---------------------------------------------------------------

function matchesQuery(lead: Lead, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const haystack = [lead.name, lead.address, lead.owner ?? "", lead.notes]
    .join(" ")
    .toLowerCase();
  if (haystack.includes(needle)) return true;

  // Phone matches on digits, so "4155550182" finds "(415) 555-0182".
  const digits = normalisePhone(needle);
  return digits.length >= 3 && normalisePhone(lead.phone).includes(digits);
}

function matchesRating(lead: Lead, filters: LeadFilters): boolean {
  if (filters.ratingMin === null && filters.ratingMax === null) return true;
  // An unrated lead cannot be shown to satisfy a rating bound, so it drops out
  // whenever one is set. The panel says so under the control.
  if (lead.rating === null) return false;
  if (filters.ratingMin !== null && lead.rating < filters.ratingMin) return false;
  if (filters.ratingMax !== null && lead.rating > filters.ratingMax) return false;
  return true;
}

function matchesCallback(
  lead: Lead,
  filters: LeadFilters,
  today: string,
  weekStart: string,
  weekEnd: string,
): boolean {
  const state = callbackState(lead, today);

  switch (filters.callback) {
    case "today":
      return state === "today";
    case "overdue":
      return state === "overdue";
    case "any":
      return state !== "none";
    case "none":
      return state === "none";
    case "week":
      return (
        lead.callbackDate !== null &&
        lead.callbackDate >= weekStart &&
        lead.callbackDate <= weekEnd
      );
    case "custom": {
      if (lead.callbackDate === null) return false;
      if (filters.callbackFrom && lead.callbackDate < filters.callbackFrom) {
        return false;
      }
      if (filters.callbackTo && lead.callbackDate > filters.callbackTo) {
        return false;
      }
      return true;
    }
    case "all":
    default:
      return true;
  }
}

/** Monday-based week bounds for the `week` range. */
export function weekBounds(today = todayIso()): { start: string; end: string } {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const mondayOffset = (date.getDay() + 6) % 7; // Sunday(0) -> 6
  const start = new Date(year, month - 1, day - mondayOffset);
  const end = new Date(year, month - 1, day - mondayOffset + 6);
  return { start: toIso(start), end: toIso(end) };
}

function toIso(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function matchesFilters(
  lead: Lead,
  filters: LeadFilters,
  today: string,
  bounds = weekBounds(today),
): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(lead.status)) {
    return false;
  }
  if (
    filters.categories.length > 0 &&
    !lead.categories.some((category) => filters.categories.includes(category))
  ) {
    return false;
  }
  if (!matchesRating(lead, filters)) return false;
  if (!matchesCallback(lead, filters, today, bounds.start, bounds.end)) return false;
  return matchesQuery(lead, filters.query);
}

// --- active-filter chips ----------------------------------------------------

export interface FilterChip {
  id: string;
  label: string;
  /** The filter set with just this chip removed. */
  next: LeadFilters;
}

function formatRating(value: number): string {
  return value.toFixed(1);
}

/**
 * One chip per active constraint, each carrying the filter set that results
 * from clearing it — so the toolbar never has to know how filters are shaped.
 */
export function describeActiveFilters(filters: LeadFilters): FilterChip[] {
  const chips: FilterChip[] = [];

  if (filters.query.trim()) {
    chips.push({
      id: "query",
      label: `Search “${filters.query.trim()}”`,
      next: { ...filters, query: "" },
    });
  }

  for (const status of filters.statuses) {
    chips.push({
      id: `status:${status}`,
      label: CALL_STATUS_LABELS[status],
      next: {
        ...filters,
        statuses: filters.statuses.filter((candidate) => candidate !== status),
      },
    });
  }

  for (const category of filters.categories) {
    chips.push({
      id: `category:${category}`,
      label: category,
      next: {
        ...filters,
        categories: filters.categories.filter(
          (candidate) => candidate !== category,
        ),
      },
    });
  }

  if (filters.ratingMin !== null || filters.ratingMax !== null) {
    const min = filters.ratingMin;
    const max = filters.ratingMax;
    const label =
      min !== null && max !== null
        ? `Rating ${formatRating(min)}–${formatRating(max)}`
        : min !== null
          ? `Rating ${formatRating(min)}+`
          : `Rating up to ${formatRating(max as number)}`;
    chips.push({
      id: "rating",
      label,
      next: { ...filters, ratingMin: null, ratingMax: null },
    });
  }

  if (filters.callback !== "all") {
    const label =
      filters.callback === "custom"
        ? `Callback ${filters.callbackFrom ?? "…"} → ${filters.callbackTo ?? "…"}`
        : CALLBACK_RANGE_LABELS[filters.callback];
    chips.push({
      id: "callback",
      label,
      next: {
        ...filters,
        callback: "all",
        callbackFrom: null,
        callbackTo: null,
      },
    });
  }

  return chips;
}

/** Cheap check used to enable "Clear all" and badge the Filters button. */
export function countActiveFilters(filters: LeadFilters): number {
  return describeActiveFilters(filters).length;
}
