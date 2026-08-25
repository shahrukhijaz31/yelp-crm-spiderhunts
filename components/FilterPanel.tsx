"use client";

import { useMemo, useState } from "react";

import {
  CALLBACK_RANGE_LABELS,
  DEMO_FILTERS,
  DEMO_FILTER_HINTS,
  DEMO_FILTER_LABELS,
  RATING_STEPS,
  type CallbackRange,
  type CategoryOption,
  type DemoFilter,
  type LeadFilters,
  type LocationOptions,
} from "@/lib/filters";
import { UNKNOWN_LOCATION, countryLabel } from "@/lib/leadLocation";
import type { LeadStats } from "@/lib/leadUtils";
import {
  CALL_STATUSES,
  CALL_STATUS_DOTS,
  CALL_STATUS_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_DOTS,
  LEAD_SOURCE_LABELS,
  type CallStatus,
  type LeadSource,
} from "@/lib/types";

const CALLBACK_ORDER: CallbackRange[] = [
  "all",
  "today",
  "week",
  "overdue",
  "any",
  "none",
  "custom",
];

/** The shared control chassis from `globals.css`; see `.ui-field`. */
const CONTROL = "ui-field";

/** How many leads each demo option would show. Absent outside the demo view. */
export interface DemoCounts {
  any: number;
  image: number;
  link: number;
}

/**
 * The filter groups, side by side so nothing is hidden behind a step.
 *
 * ---------------------------------------------------------------------------
 * Why the lists are one column
 * ---------------------------------------------------------------------------
 * They were two, and every label in them was ellipsised into uselessness:
 * "Called - Owner not available" arrived as `Ca…`, and a filter you cannot read
 * is a filter you cannot use. Two columns halve an already-narrow column and
 * then spend what is left on a checkbox, a status dot and a count, leaving
 * about seventy pixels for the words.
 *
 * One column costs vertical space — eight statuses is eight rows — and buys
 * back the entire point of the control. The category list keeps its own scroll
 * box, so its height is fixed whatever the count.
 */
export default function FilterPanel({
  filters,
  onChange,
  categories,
  locations,
  stats,
  section = "leads",
  demoCounts,
}: {
  filters: LeadFilters;
  onChange: (filters: LeadFilters) => void;
  categories: CategoryOption[];
  locations: LocationOptions;
  stats: LeadStats;
  /** The demo band is drawn for the Demo Websites view only. */
  section?: "leads" | "demo";
  demoCounts?: DemoCounts;
}) {
  const [categoryQuery, setCategoryQuery] = useState("");
  const [cityQuery, setCityQuery] = useState("");

  function toggleStatus(status: CallStatus) {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((candidate) => candidate !== status)
      : [...filters.statuses, status];
    onChange({ ...filters, statuses: next });
  }

  function toggleSource(source: LeadSource) {
    const next = filters.sources.includes(source)
      ? filters.sources.filter((candidate) => candidate !== source)
      : [...filters.sources, source];
    onChange({ ...filters, sources: next });
  }

  function toggleCategory(name: string) {
    const next = filters.categories.includes(name)
      ? filters.categories.filter((candidate) => candidate !== name)
      : [...filters.categories, name];
    onChange({ ...filters, categories: next });
  }

  function toggleCountry(code: string) {
    const next = filters.countries.includes(code)
      ? filters.countries.filter((candidate) => candidate !== code)
      : [...filters.countries, code];
    onChange({ ...filters, countries: next });
  }

  function toggleCity(name: string) {
    const next = filters.cities.includes(name)
      ? filters.cities.filter((candidate) => candidate !== name)
      : [...filters.cities, name];
    onChange({ ...filters, cities: next });
  }

  const visibleCategories = categories.filter((category) =>
    category.name.toLowerCase().includes(categoryQuery.trim().toLowerCase()),
  );

  /*
   * The town list, narrowed to the selected countries — the one place the two
   * location controls are related to each other.
   *
   * They are independent in the *query* (`matchesFilters` ANDs them like any
   * other pair of groups); the cascade is a display rule and lives only here,
   * because this is the only layer that knows which country a town is in. Which
   * is the right place for it: an agent who ticks "United Kingdom" wants the
   * next list to be British towns, not four thousand towns worldwide.
   *
   * One town in two countries is two rows in `locations.cities`, so they are
   * folded back together by name after the narrowing. Otherwise picking both
   * the UK and the US would offer "Richmond" twice, with a checkbox each,
   * ticking the same filter.
   *
   * A town that is already ticked always survives, whatever the country
   * selection is. Without that, unticking a country would leave its towns
   * filtering the worklist from outside the panel — active, invisible, and
   * clearable only from the chip in the toolbar.
   */
  const visibleCities = useMemo(() => {
    const wanted = filters.countries;
    const totals = new Map<string, number>();

    for (const city of locations.cities) {
      const inScope = wanted.length === 0 || wanted.includes(city.country);
      if (!inScope && !filters.cities.includes(city.name)) continue;
      totals.set(city.name, (totals.get(city.name) ?? 0) + city.count);
    }

    const needle = cityQuery.trim().toLowerCase();
    return Array.from(totals, ([name, count]) => ({ name, count }))
      .filter((city) => city.name.toLowerCase().includes(needle))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [locations.cities, filters.countries, filters.cities, cityQuery]);

  const demoTotal = stats.total;

  return (
    <div className="flex flex-col gap-4">
      {/*
        * --- Demo content ------------------------------------------------
        *
        * A full-width band above the rest rather than a fifth column, and that
        * is the whole design decision: in the Demo Websites view this is the
        * filter people reach for — "what still needs building" and "what can I
        * show today" are the two questions the screen exists to answer — and a
        * fifth 180px column beside Rating would have buried it.
        *
        * Buttons rather than checkboxes because the states are exclusive, and
        * with counts because "No demo yet · 30,412" answers the question
        * without the click.
        */}
      {section === "demo" && (
        <section aria-labelledby="filter-demo" className="panel-inset px-3.5 py-3">
          <div className="mb-2.5 flex items-center gap-2">
            <h3 id="filter-demo" className="eyebrow text-accent">
              Demo content
            </h3>
            <span className="text-caption text-fg-4">
              What has been built for these leads
            </span>
            {filters.demo !== "all" && (
              <span className="ml-auto">
                <Reset onClick={() => onChange({ ...filters, demo: "all" })} />
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {DEMO_FILTERS.map((option) => {
              const active = filters.demo === option;
              const count = demoCountFor(option, demoCounts, demoTotal);

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChange({ ...filters, demo: option })}
                  aria-pressed={active}
                  title={DEMO_FILTER_HINTS[option]}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-caption transition-colors ${
                    active
                      ? "border-accent-line bg-accent-soft font-medium text-accent"
                      : "border-line bg-surface text-fg-2 hover:border-line-2 hover:text-fg"
                  }`}
                >
                  {DEMO_FILTER_LABELS[option]}
                  {count !== null && (
                    <span
                      className={`tnum font-mono text-meta ${active ? "text-accent" : "text-fg-4"}`}
                    >
                      {count.toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* `gap-x-6` rather than 8: two of these columns hold wrapping labels,
          and 16px of the gutter is better spent on the words. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-[minmax(200px,1fr)_minmax(200px,1fr)_minmax(200px,1fr)_150px_195px] xl:gap-y-4">
      {/* --- Status: multi-select ------------------------------------- */}
      <Group
        title="Status"
        action={
          filters.statuses.length > 0 && (
            <Reset onClick={() => onChange({ ...filters, statuses: [] })} />
          )
        }
      >
        {/* One column — see the note on this component. `Called - Owner not
            available` is the longest label in the app and it has to fit. */}
        <div className="flex flex-col gap-y-0.5">
          {CALL_STATUSES.map((status) => (
            <Check
              key={status}
              checked={filters.statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${CALL_STATUS_DOTS[status]}`}
              />
              {/* Wraps rather than truncates. One column already gives these
                  room at every width the panel is used at, but "Called - Owner
                  not available" is long enough that a narrow window would clip
                  it again — and a status you cannot read is a status you cannot
                  filter by. Two lines is a cheaper price than an ellipsis. */}
              <span className="min-w-0 flex-1 leading-snug">{CALL_STATUS_LABELS[status]}</span>
              <span className="tnum shrink-0 font-mono text-meta text-fg-3">
                {stats.byStatus[status]}
              </span>
            </Check>
          ))}
        </div>

        {/*
          * --- Source ---------------------------------------------------
          *
          * Under Status rather than in a column of its own. Two options is not
          * a column's worth of control — a fifth 215px track for two checkboxes
          * would take width off Category, which is the list that actually needs
          * it — and this belongs next to Status anyway: they are the two things
          * an agent narrows by before they read a single row.
          *
          * Checkboxes and not buttons, unlike the demo band above, because the
          * two are additive: ticking both is "everything", the same set as
          * ticking neither. Exclusive buttons would have needed a third "All"
          * option to say the same thing.
          */}
        <div className="mt-4">
          <div className="mb-2.5 flex items-center gap-2 border-b border-line pb-1.5">
            <h3 className="eyebrow">Source</h3>
            {filters.sources.length > 0 && (
              <span className="ml-auto">
                <Reset onClick={() => onChange({ ...filters, sources: [] })} />
              </span>
            )}
          </div>
          <div className="flex flex-col gap-y-0.5">
            {LEAD_SOURCES.map((source) => (
              <Check
                key={source}
                checked={filters.sources.includes(source)}
                onChange={() => toggleSource(source)}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEAD_SOURCE_DOTS[source]}`}
                />
                <span className="min-w-0 flex-1 leading-snug">
                  {LEAD_SOURCE_LABELS[source]}
                </span>
                <span className="tnum shrink-0 font-mono text-meta text-fg-3">
                  {stats.bySource[source]}
                </span>
              </Check>
            ))}
          </div>
        </div>
      </Group>

      {/* --- Category / industry: multi-select ------------------------- */}
      <Group
        title="Category / industry"
        action={
          filters.categories.length > 0 && (
            <Reset onClick={() => onChange({ ...filters, categories: [] })} />
          )
        }
      >
        <input
          type="search"
          value={categoryQuery}
          onChange={(event) => setCategoryQuery(event.target.value)}
          placeholder="Find a category…"
          aria-label="Find a category"
          className={`${CONTROL} mb-2 w-full placeholder:text-fg-3`}
        />
        {/* Taller than it was: one column shows half as many rows at a time,
            and a five-row window over a hundred categories is a scrollbar with
            a list attached. */}
        <div className="max-h-[232px] overflow-y-auto pr-1">
          {visibleCategories.length === 0 ? (
            <p className="py-2 text-ui text-fg-3">No matching category.</p>
          ) : (
            <div className="flex flex-col gap-y-0.5">
              {visibleCategories.map((category) => (
                <Check
                  key={category.name}
                  checked={filters.categories.includes(category.name)}
                  onChange={() => toggleCategory(category.name)}
                >
                  {/* Still truncated — a scraped category can be arbitrarily
                      long — but never silently: the full name is in the title,
                      and one column means the common ones now fit outright. */}
                  <span className="min-w-0 flex-1 truncate" title={category.name}>
                    {category.name}
                  </span>
                  <span className="tnum shrink-0 font-mono text-meta text-fg-3">
                    {category.count}
                  </span>
                </Check>
              ))}
            </div>
          )}
        </div>
      </Group>

      {/* --- Location: country, then the towns within it ---------------- */}
      <Group
        title="Location"
        action={
          (filters.countries.length > 0 || filters.cities.length > 0) && (
            <Reset
              onClick={() => onChange({ ...filters, countries: [], cities: [] })}
            />
          )
        }
      >
        {/*
          * Country above town, and both in one column, because that is the
          * order the question is asked in: an agent picks the country they are
          * calling into and then, sometimes, a town inside it. The town list
          * narrows to whatever countries are ticked — see `visibleCities`.
          *
          * Neither list is scraped from a column the directories provide;
          * `lib/leadLocation.ts` reads both out of the address. That is why
          * "Unknown location" is an option rather than a silence: it is the
          * count of addresses the rules could not place, and an agent can
          * select it and work those leads like any others.
          */}
        {locations.countries.length === 0 ? (
          <p className="py-2 text-ui text-fg-3">No location data yet.</p>
        ) : (
          <div className="flex flex-col gap-y-0.5">
            {locations.countries.map((country) => (
              <Check
                key={country.code}
                checked={filters.countries.includes(country.code)}
                onChange={() => toggleCountry(country.code)}
              >
                <span
                  className={`min-w-0 flex-1 truncate leading-snug ${
                    country.code === UNKNOWN_LOCATION ? "italic text-fg-3" : ""
                  }`}
                  title={countryLabel(country.code)}
                >
                  {countryLabel(country.code)}
                </span>
                <span className="tnum shrink-0 font-mono text-meta text-fg-3">
                  {country.count.toLocaleString()}
                </span>
              </Check>
            ))}
          </div>
        )}

        <div className="mt-4">
          <div className="mb-2.5 flex items-center gap-2 border-b border-line pb-1.5">
            <h3 className="eyebrow">Town / city</h3>
            {filters.countries.length > 0 && (
              <span className="text-caption text-fg-4">
                in {filters.countries.length === 1
                  ? countryLabel(filters.countries[0])
                  : `${filters.countries.length} countries`}
              </span>
            )}
            {filters.cities.length > 0 && (
              <span className="ml-auto">
                <Reset onClick={() => onChange({ ...filters, cities: [] })} />
              </span>
            )}
          </div>

          <input
            type="search"
            value={cityQuery}
            onChange={(event) => setCityQuery(event.target.value)}
            placeholder="Find a town…"
            aria-label="Find a town"
            className={`${CONTROL} mb-2 w-full placeholder:text-fg-3`}
          />

          {/* The same scroll box the category list gets, and for the same
              reason: a country with four hundred towns in it must not make the
              filter panel four hundred rows tall. */}
          <div className="max-h-[176px] overflow-y-auto pr-1">
            {visibleCities.length === 0 ? (
              <p className="py-2 text-ui text-fg-3">No matching town.</p>
            ) : (
              <div className="flex flex-col gap-y-0.5">
                {visibleCities.map((city) => (
                  <Check
                    key={city.name}
                    checked={filters.cities.includes(city.name)}
                    onChange={() => toggleCity(city.name)}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        city.name === UNKNOWN_LOCATION ? "italic text-fg-3" : ""
                      }`}
                      title={city.name === UNKNOWN_LOCATION ? "Unknown town" : city.name}
                    >
                      {city.name === UNKNOWN_LOCATION ? "Unknown town" : city.name}
                    </span>
                    <span className="tnum shrink-0 font-mono text-meta text-fg-3">
                      {city.count.toLocaleString()}
                    </span>
                  </Check>
                ))}
              </div>
            )}
          </div>
        </div>
      </Group>

      {/* --- Rating range --------------------------------------------- */}
      <Group
        title="Rating"
        action={
          (filters.ratingMin !== null || filters.ratingMax !== null) && (
            <Reset
              onClick={() =>
                onChange({ ...filters, ratingMin: null, ratingMax: null })
              }
            />
          )
        }
      >
        <div className="flex items-center gap-2">
          <RatingSelect
            label="Minimum rating"
            value={filters.ratingMin}
            anyLabel="Any"
            onChange={(ratingMin) => onChange({ ...filters, ratingMin })}
          />
          <span className="text-caption text-fg-3">to</span>
          <RatingSelect
            label="Maximum rating"
            value={filters.ratingMax}
            anyLabel="Any"
            onChange={(ratingMax) => onChange({ ...filters, ratingMax })}
          />
        </div>
        <p className="mt-2 text-caption leading-snug text-fg-3">
          Leads with no rating are excluded while a bound is set.
        </p>
      </Group>

      {/* --- Callback date range -------------------------------------- */}
      <Group
        title="Callback date"
        action={
          filters.callback !== "all" && (
            <Reset
              onClick={() =>
                onChange({
                  ...filters,
                  callback: "all",
                  callbackFrom: null,
                  callbackTo: null,
                })
              }
            />
          )
        }
      >
        {/* One column: these labels are sentences, and truncating a date range
            option is worse than the extra height. */}
        <div className="flex flex-col gap-y-0.5">
          {CALLBACK_ORDER.map((range) => (
            <label
              key={range}
              className="flex cursor-pointer items-center gap-2.5 py-1 text-ui text-fg-2 transition-colors hover:text-fg"
            >
              <input
                type="radio"
                name="callback-range"
                checked={filters.callback === range}
                onChange={() => onChange({ ...filters, callback: range })}
                className="h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0 flex-1 leading-snug">
                {CALLBACK_RANGE_LABELS[range]}
              </span>
            </label>
          ))}
        </div>

        {/* Stacked, not side by side: two native date inputs need ~290px and
            this column is 230px, so a row would overflow the panel. */}
        {filters.callback === "custom" && (
          <div className="mt-2.5 flex flex-col gap-1.5 border-l-2 border-accent-line pl-2.5">
            <DateBound
              label="From"
              value={filters.callbackFrom}
              onChange={(callbackFrom) => onChange({ ...filters, callbackFrom })}
            />
            <DateBound
              label="To"
              value={filters.callbackTo}
              onChange={(callbackTo) => onChange({ ...filters, callbackTo })}
            />
            <p className="text-caption leading-snug text-fg-3">
              Leave either side empty for an open-ended range.
            </p>
          </div>
        )}
      </Group>
      </div>
    </div>
  );
}

/**
 * The count on one demo button, or null when there is nothing to say.
 *
 * "All leads" and "No demo yet" are both derived from the workspace total
 * rather than counted separately — the aggregate counts what *has* demo
 * content, and the complement is arithmetic. `null` when the counts have not
 * arrived yet, so a button shows its label alone rather than a confident zero.
 */
function demoCountFor(
  option: DemoFilter,
  counts: DemoCounts | undefined,
  total: number,
): number | null {
  if (!counts) return null;
  switch (option) {
    case "all":
      return total;
    case "any":
      return counts.any;
    case "none":
      return Math.max(0, total - counts.any);
    case "image":
      return counts.image;
    case "link":
      return counts.link;
  }
}

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2.5 flex items-center gap-2 border-b border-line pb-1.5">
        <h3 className="eyebrow">{title}</h3>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function DateBound({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-caption text-fg-3">{label}</span>
      <input
        type="date"
        aria-label={`Callback ${label.toLowerCase()}`}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className={`${CONTROL} min-w-0 flex-1`}
      />
    </label>
  );
}

function Reset({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-caption font-medium text-fg-3 underline decoration-line-2 underline-offset-2 transition-colors hover:text-accent"
    >
      Reset
    </button>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2 py-1 text-ui text-fg-2 transition-colors hover:text-fg">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 shrink-0 accent-accent"
      />
      {children}
    </label>
  );
}

function RatingSelect({
  label,
  value,
  anyLabel,
  onChange,
}: {
  label: string;
  value: number | null;
  anyLabel: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value === null ? "" : String(value)}
      onChange={(event) =>
        onChange(event.target.value === "" ? null : Number(event.target.value))
      }
      className={`${CONTROL} w-full cursor-pointer`}
    >
      <option value="">{anyLabel}</option>
      {RATING_STEPS.map((step) => (
        <option key={step} value={step}>
          {step.toFixed(1)} ★
        </option>
      ))}
    </select>
  );
}
