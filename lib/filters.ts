import { UNKNOWN_LOCATION, countryLabel } from "./leadLocation";
import { callbackState, normalisePhone, todayIso } from "./leadUtils";
import {
  CALL_STATUS_LABELS,
  LEAD_SOURCE_LABELS,
  type CallStatus,
  type Lead,
  type LeadSource,
} from "./types";

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

/**
 * The demo filter, and the only filter in this file that is **not** a property
 * of the lead.
 *
 * Every other filter here reads a column on `leads`. This one asks whether the
 * lead has a row in `demo_websites` and what is on it, which is a join — so it
 * is evaluated in SQL only (`leadFilterSql`) and `matchesFilters` below cannot
 * answer it. That is not a gap: the demo view is server-paged, and the one
 * caller of `matchesFilters` (`LeadsProvider`, for Export and Meetings) never
 * sets this.
 *
 * Five states rather than a checkbox, because "has a demo" and "has no demo"
 * are both things an agent actually looks for — the first to find something to
 * present, the second to find the next site to build.
 */
export const DEMO_FILTERS = ["all", "any", "none", "image", "link"] as const;

export type DemoFilter = (typeof DEMO_FILTERS)[number];

export const DEMO_FILTER_LABELS: Record<DemoFilter, string> = {
  all: "All leads",
  any: "Has a demo",
  none: "No demo yet",
  image: "Has an image",
  link: "Has a link",
};

/** One line each, for the tooltip on a filter that is otherwise two words. */
export const DEMO_FILTER_HINTS: Record<DemoFilter, string> = {
  all: "Every lead, with or without demo content.",
  any: "Leads with a demo image, a demo link, or both.",
  none: "Leads nothing has been built for yet.",
  image: "Leads with a demo image uploaded.",
  link: "Leads with a demo link saved.",
};

export interface LeadFilters {
  /** Free text over name, address, phone, notes and owner. */
  query: string;
  /** Empty means "all statuses" rather than "none". */
  statuses: CallStatus[];
  /**
   * Which directories to show. Empty means all of them, exactly like
   * `statuses` — and with two sources that is the same set as ticking both, so
   * the panel's Reset and "untick everything" land on one state rather than
   * two that look identical and query differently.
   */
  sources: LeadSource[];
  /** Empty means "all categories". A lead matches if it has *any* of these. */
  categories: string[];
  /**
   * Which countries to show, as ISO-2 codes, plus the literal
   * {@link UNKNOWN_LOCATION} for leads whose address could not be parsed.
   *
   * Empty means every country, the same rule `statuses`, `sources` and
   * `categories` all follow: a filter narrows, it never excludes. Untouched, it
   * therefore shows the unparseable leads too — which is the only safe default,
   * because an agent who has not asked about location must never silently stop
   * being shown leads the parser could not place.
   */
  countries: string[];
  /**
   * Which towns to show, spelled exactly as `leads.city` stores them (the
   * parser normalises case, so there is one spelling per town), plus
   * {@link UNKNOWN_LOCATION}.
   *
   * Independent of `countries` rather than nested under it: the two are ANDed
   * like every other pair of groups here, so ticking a country and a town in a
   * different one legitimately matches nothing. The panel only *offers* the
   * towns in the selected countries, which is where that pairing belongs — a
   * display rule, not a query one.
   */
  cities: string[];
  ratingMin: number | null;
  ratingMax: number | null;
  callback: CallbackRange;
  /** Inclusive ISO bounds, only read when `callback` is `custom`. */
  callbackFrom: string | null;
  callbackTo: string | null;
  /**
   * Demo content. Only ever set by the Demo Websites view — the worklist does
   * not offer it and `parseLeadSearchParams` will not read it outside that
   * section, so a hand-edited worklist URL cannot arrive carrying a filter that
   * screen has no control to clear.
   */
  demo: DemoFilter;
}

export const EMPTY_FILTERS: LeadFilters = {
  query: "",
  statuses: [],
  sources: [],
  categories: [],
  countries: [],
  cities: [],
  ratingMin: null,
  ratingMax: null,
  callback: "all",
  callbackFrom: null,
  callbackTo: null,
  demo: "all",
};

/** Selectable rating steps — the half-star values both directories report. */
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

// --- location options -------------------------------------------------------

export interface CountryOption {
  /** ISO-2, or {@link UNKNOWN_LOCATION} for the leads with no country. */
  code: string;
  count: number;
}

export interface CityOption {
  /** The town, or {@link UNKNOWN_LOCATION}. */
  name: string;
  /** Which country it was counted under — what lets the panel cascade. */
  country: string;
  count: number;
}

/**
 * The two lists the Location group offers, paired so the panel can narrow the
 * towns to the selected countries. Built by `leadLocations()` from SQL for the
 * paged screens, and by {@link collectLocations} in memory for Export.
 */
export interface LocationOptions {
  countries: CountryOption[];
  cities: CityOption[];
}

export const EMPTY_LOCATION_OPTIONS: LocationOptions = { countries: [], cities: [] };

/**
 * The same lists as `leadLocations()`, from leads already in memory.
 *
 * The counterpart to {@link collectCategories}, and it exists for the same one
 * caller: Export holds every matching lead client-side, so asking the server
 * for facets it could count from the array it is holding would be a round trip
 * for an answer it already has. `null` becomes {@link UNKNOWN_LOCATION} here
 * exactly as it does in SQL, so the two lists are interchangeable.
 */
export function collectLocations(leads: Lead[]): LocationOptions {
  const countries = new Map<string, number>();
  const cities = new Map<string, CityOption>();

  for (const lead of leads) {
    const country = lead.country ?? UNKNOWN_LOCATION;
    const city = lead.city ?? UNKNOWN_LOCATION;
    countries.set(country, (countries.get(country) ?? 0) + 1);
    // Keyed by the pair, because one town name in two countries is two options
    // — and the panel has to know which country each belongs to.
    const key = `${country}/${city}`;
    const existing = cities.get(key);
    if (existing) existing.count += 1;
    else cities.set(key, { name: city, country, count: 1 });
  }

  return {
    countries: Array.from(countries, ([code, count]) => ({ code, count })).sort(
      (a, b) => b.count - a.count || a.code.localeCompare(b.code),
    ),
    cities: Array.from(cities.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
  };
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

/**
 * One location field against one selection.
 *
 * The whole of the location matching, for both country and city, because the
 * two behave identically: empty selection matches everything, a null field
 * matches only when {@link UNKNOWN_LOCATION} was picked. That second rule is
 * what makes "Unknown location" a real option rather than a label on a bucket
 * nothing can reach — and it is why the sentinel exists at all, since SQL and
 * JavaScript both refuse to find NULL in a list of strings.
 */
function matchesLocation(value: string | null, selected: string[]): boolean {
  if (selected.length === 0) return true;
  if (value === null) return selected.includes(UNKNOWN_LOCATION);
  return selected.includes(value);
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

/**
 * Does this lead match?
 *
 * **`filters.demo` is deliberately not evaluated here.** It asks about a row in
 * another table, and a `Lead` does not carry one — see the note on
 * {@link DEMO_FILTERS}. The only caller is `LeadsProvider`, which serves Export
 * and Meetings and never sets it; the Demo Websites view is server-paged and
 * gets the clause from `leadFilterSql`. Answering "true" for a filter this
 * function cannot see would be a silent lie, so it is stated instead.
 */
export function matchesFilters(
  lead: Lead,
  filters: LeadFilters,
  today: string,
  bounds = weekBounds(today),
): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(lead.status)) {
    return false;
  }
  if (filters.sources.length > 0 && !filters.sources.includes(lead.source)) {
    return false;
  }
  if (
    filters.categories.length > 0 &&
    !lead.categories.some((category) => filters.categories.includes(category))
  ) {
    return false;
  }
  if (!matchesLocation(lead.country, filters.countries)) return false;
  if (!matchesLocation(lead.city, filters.cities)) return false;
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

  for (const source of filters.sources) {
    chips.push({
      id: `source:${source}`,
      label: LEAD_SOURCE_LABELS[source],
      next: {
        ...filters,
        sources: filters.sources.filter((candidate) => candidate !== source),
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

  for (const country of filters.countries) {
    chips.push({
      id: `country:${country}`,
      label: countryLabel(country),
      /*
       * Only the country is cleared, never the towns picked under it.
       *
       * Tempting to clear both — but this function is pure over `LeadFilters`
       * and has no idea which country a town is in, so "the towns that belonged
       * to it" is not something it can compute. Guessing (clear all towns when
       * the last country goes) would silently discard a selection an agent
       * made, which is worse than leaving it. The panel is where the two are
       * related, and it keeps every selected town visible and untickable
       * whatever the country selection is, so nothing can end up active and
       * unreachable.
       */
      next: {
        ...filters,
        countries: filters.countries.filter((candidate) => candidate !== country),
      },
    });
  }

  for (const city of filters.cities) {
    chips.push({
      id: `city:${city}`,
      label: city === UNKNOWN_LOCATION ? "Unknown town" : city,
      next: {
        ...filters,
        cities: filters.cities.filter((candidate) => candidate !== city),
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

  if (filters.demo !== "all") {
    chips.push({
      id: "demo",
      label: DEMO_FILTER_LABELS[filters.demo],
      next: { ...filters, demo: "all" },
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
