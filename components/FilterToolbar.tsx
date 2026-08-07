"use client";

import { useEffect, useRef } from "react";

import FilterPanel from "./FilterPanel";
import {
  describeActiveFilters,
  EMPTY_FILTERS,
  type CategoryOption,
  type LeadFilters,
} from "@/lib/filters";
import type { LeadStats } from "@/lib/leadUtils";

/**
 * The control rail: instant search, the filter expander, the active-filter
 * chips and the result counter.
 *
 * An inline expander rather than an overlay drawer — an overlay would cover
 * the table you are filtering, and this is a desktop tool where watching the
 * row count move as you tick boxes is the point.
 */
export default function FilterToolbar({
  filters,
  onChange,
  categories,
  stats,
  shown,
  open,
  onToggleOpen,
}: {
  filters: LeadFilters;
  onChange: (filters: LeadFilters) => void;
  categories: CategoryOption[];
  stats: LeadStats;
  shown: number;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const chips = describeActiveFilters(filters);
  const isFiltered = chips.length > 0;
  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * `/` jumps to search. An agent working the list has both hands on the
   * keyboard between calls, and reaching for the mouse to filter is the one
   * interruption this screen can cheaply remove.
   *
   * Guarded on where the keystroke came from: inside any field — including a
   * note being typed, or the category search in the panel below — a slash is
   * just a slash. Modifier chords are left alone so browser shortcuts still
   * work.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      // Otherwise the slash lands in the field it just focused.
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <section className="rounded-xl border border-line bg-rail">
      <div className="flex flex-wrap items-center gap-3 px-3 py-3">
        <div className="group relative w-full sm:w-auto">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search leads by name, address, phone or notes"
            aria-keyshortcuts="/"
            value={filters.query}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
            placeholder="Search name, address, phone, notes…"
            className="h-10 w-full rounded-lg sm:w-[22rem] border border-line-2 bg-recessed pl-9 pr-9 text-ui text-fg outline-none transition-colors placeholder:text-fg-3 hover:border-fg-4 focus:border-accent focus:ring-2 focus:ring-accent/25"
          />
          {/* Hidden once there is a query: a keycap sitting on top of the text
              an agent is reading back is worse than no hint at all. */}
          {!filters.query && <SearchKeyHint />}
        </div>

        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls="filter-panel"
          className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3.5 text-ui font-medium transition-colors ${
            open || isFiltered
              ? "border-accent/60 bg-accent-soft text-accent"
              : "border-line-2 bg-recessed text-fg-2 hover:border-fg-4 hover:bg-hover hover:text-fg"
          }`}
        >
          <SlidersIcon />
          Filters
          {chips.length > 0 && (
            <span className="tnum rounded bg-accent px-1.5 py-0.5 font-mono text-meta font-medium text-on-accent">
              {chips.length}
            </span>
          )}
          <ChevronIcon open={open} />
        </button>

        <p className="ml-auto text-ui text-fg-3">
          Showing{" "}
          <span className="tnum font-mono text-num font-semibold text-fg">
            {shown}
          </span>{" "}
          of <span className="tnum font-mono text-num text-fg-2">{stats.total}</span>{" "}
          total leads
        </p>
      </div>

      {/* Active filters, one chip each, removable individually. */}
      {isFiltered && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
          <span className="eyebrow mr-1">Active</span>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onChange(chip.next)}
              title={`Remove filter: ${chip.label}`}
              className="group inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-line-2 bg-surface py-1 pl-2.5 pr-1.5 text-caption text-fg-2 transition-colors hover:border-accent/60 hover:text-fg"
            >
              <span className="truncate">{chip.label}</span>
              <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors group-hover:bg-accent group-hover:text-on-accent"
              >
                <CrossIcon />
              </span>
            </button>
          ))}

          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_FILTERS })}
            className="ml-1 rounded px-2 py-1 text-caption font-medium text-accent underline decoration-accent/40 underline-offset-4 transition-colors hover:decoration-accent"
          >
            Clear all
          </button>
        </div>
      )}

      {open && (
        <div id="filter-panel" className="border-t border-line px-4 py-4">
          <FilterPanel
            filters={filters}
            onChange={onChange}
            categories={categories}
            stats={stats}
          />
        </div>
      )}
    </section>
  );
}

/**
 * The `/` keycap. Purely decorative — the shortcut is announced to assistive
 * tech by `aria-keyshortcuts` on the input, and repeating it here would just
 * make the field's accessible name longer.
 */
function SearchKeyHint() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute right-2.5 top-1/2 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded border border-line-2 bg-surface px-1 font-mono text-[11px] leading-none text-fg-3 transition-opacity group-focus-within:opacity-0"
    >
      /
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3 transition-colors group-focus-within:text-accent"
    >
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        d="M2 4.5h5M11 4.5h3M2 11.5h3M9 11.5h5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="9" cy="4.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="11.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path
        d="M2.5 4.5 6 8 9.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="h-2.5 w-2.5">
      <path
        d="m2.5 2.5 5 5m0-5-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
