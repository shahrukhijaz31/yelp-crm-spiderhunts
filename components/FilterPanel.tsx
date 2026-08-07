"use client";

import { useState } from "react";

import {
  CALLBACK_RANGE_LABELS,
  RATING_STEPS,
  type CallbackRange,
  type CategoryOption,
  type LeadFilters,
} from "@/lib/filters";
import type { LeadStats } from "@/lib/leadUtils";
import {
  CALL_STATUSES,
  CALL_STATUS_DOTS,
  CALL_STATUS_LABELS,
  type CallStatus,
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

/** The four filter groups, side by side so nothing is hidden behind a step. */
export default function FilterPanel({
  filters,
  onChange,
  categories,
  stats,
}: {
  filters: LeadFilters;
  onChange: (filters: LeadFilters) => void;
  categories: CategoryOption[];
  stats: LeadStats;
}) {
  const [categoryQuery, setCategoryQuery] = useState("");

  function toggleStatus(status: CallStatus) {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((candidate) => candidate !== status)
      : [...filters.statuses, status];
    onChange({ ...filters, statuses: next });
  }

  function toggleCategory(name: string) {
    const next = filters.categories.includes(name)
      ? filters.categories.filter((candidate) => candidate !== name)
      : [...filters.categories, name];
    onChange({ ...filters, categories: next });
  }

  const visibleCategories = categories.filter((category) =>
    category.name.toLowerCase().includes(categoryQuery.trim().toLowerCase()),
  );

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.15fr)_180px_230px] xl:gap-y-4">
      {/* --- Status: multi-select ------------------------------------- */}
      <Group
        title="Status"
        action={
          filters.statuses.length > 0 && (
            <Reset onClick={() => onChange({ ...filters, statuses: [] })} />
          )
        }
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
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
              <span className="truncate">{CALL_STATUS_LABELS[status]}</span>
              <span className="tnum ml-auto font-mono text-meta text-fg-3">
                {stats.byStatus[status]}
              </span>
            </Check>
          ))}
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
        <div className="max-h-[148px] overflow-y-auto pr-1">
          {visibleCategories.length === 0 ? (
            <p className="py-2 text-ui text-fg-3">No matching category.</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {visibleCategories.map((category) => (
                <Check
                  key={category.name}
                  checked={filters.categories.includes(category.name)}
                  onChange={() => toggleCategory(category.name)}
                >
                  <span className="truncate">{category.name}</span>
                  <span className="tnum ml-auto font-mono text-meta text-fg-3">
                    {category.count}
                  </span>
                </Check>
              ))}
            </div>
          )}
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
              <span className="truncate">{CALLBACK_RANGE_LABELS[range]}</span>
            </label>
          ))}
        </div>

        {/* Stacked, not side by side: two native date inputs need ~290px and
            this column is 230px, so a row would overflow the panel. */}
        {filters.callback === "custom" && (
          <div className="mt-2.5 flex flex-col gap-1.5 border-l-2 border-accent/40 pl-2.5">
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
  );
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
    <label className="flex min-w-0 cursor-pointer items-center gap-2.5 py-1 text-ui text-fg-2 transition-colors hover:text-fg">
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
