"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ListFilter, Search, X } from "lucide-react";

import FilterPanel, { type DemoCounts } from "./FilterPanel";
import {
  describeActiveFilters,
  EMPTY_FILTERS,
  type CategoryOption,
  type LeadFilters,
} from "@/lib/filters";
import type { LeadStats } from "@/lib/leadUtils";

/**
 * The command bar: instant search, the filter expander, the active-filter chips
 * and the result counter.
 *
 * It no longer draws a panel of its own. It is a *strip inside* the workspace
 * surface, sitting directly on top of the table it narrows, separated by one
 * hairline — so the toolbar and the rows read as one object with a control
 * surface, rather than as two cards that happen to be stacked. That is the
 * single biggest structural difference between this and a generic admin table.
 *
 * An inline expander rather than an overlay drawer: an overlay would cover the
 * table you are filtering, and this is a desktop tool where watching the row
 * count move as you tick boxes is the point.
 */
export default function FilterToolbar({
  filters,
  onChange,
  categories,
  stats,
  shown,
  open,
  onToggleOpen,
  section = "leads",
  demoCounts,
}: {
  filters: LeadFilters;
  onChange: (filters: LeadFilters) => void;
  categories: CategoryOption[];
  stats: LeadStats;
  shown: number;
  open: boolean;
  onToggleOpen: () => void;
  /** Passed straight through: it decides whether the demo band is drawn. */
  section?: "leads" | "demo";
  demoCounts?: DemoCounts;
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
    <div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        {/* --- search --- */}
        <div className="group relative w-full sm:w-auto">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-4 transition-colors group-focus-within:text-fg-3"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search leads by name, address, phone or notes"
            aria-keyshortcuts="/"
            value={filters.query}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
            placeholder="Search leads…"
            // `bg-recessed` rather than the field default: this control sits on
            // a `rail` strip, and a surface-coloured input on a rail strip has
            // no edge at all until you find its border.
            className="ui-field h-8 w-full !bg-recessed pl-8 pr-9 sm:w-[280px] lg:w-[340px]"
          />
          {/* Hidden once there is a query: a keycap sitting on top of the text
              an agent is reading back is worse than no hint at all. */}
          {!filters.query && <SearchKeyHint />}
        </div>

        {/* --- filters --- */}
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls="filter-panel"
          // Filters *applied* is the state worth marking, and it is marked
          // whether or not the panel is open — the panel merely being open is
          // not information about the list.
          className={`ui-btn h-8 px-2.5 text-caption ${
            isFiltered
              ? "border border-accent-line bg-accent-soft text-accent hover:bg-accent-soft"
              : open
                ? "ui-btn-secondary"
                : "ui-btn-ghost"
          }`}
        >
          <ListFilter className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Filters
          {chips.length > 0 && (
            <span className="tnum font-mono text-meta font-medium">{chips.length}</span>
          )}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>

        {/* --- count --- */}
        <p className="ml-auto shrink-0 text-caption text-fg-3">
          <span className="tnum font-mono font-medium text-fg-2">
            {shown.toLocaleString()}
          </span>
          <span className="text-fg-4"> / </span>
          <span className="tnum font-mono">{stats.total.toLocaleString()}</span>
        </p>
      </div>

      {/* --- active filters --- */}
      {/* Each chip scales in from 92% and out again when removed, so adding
          and clearing a filter are visibly the same action reversed. Keyed by
          the chip's own id, which is what lets `AnimatePresence` animate the
          removal of one chip from the middle of the row without disturbing
          the others. */}
      {isFiltered && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
          <AnimatePresence initial={false} mode="popLayout">
            {chips.map((chip) => (
              <motion.button
                key={chip.id}
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.16, ease: [0.22, 0.61, 0.36, 1] }}
                type="button"
                onClick={() => onChange(chip.next)}
                title={`Remove filter: ${chip.label}`}
                className="group inline-flex max-w-[240px] items-center gap-1 rounded-md border border-line-2 bg-surface py-0.5 pl-2 pr-1 text-caption text-fg-2 transition-colors hover:border-fg-4 hover:text-fg"
              >
                <span className="truncate">{chip.label}</span>
                <X
                  className="h-3 w-3 shrink-0 text-fg-4 transition-colors group-hover:text-accent"
                  strokeWidth={2.25}
                  aria-hidden="true"
                />
              </motion.button>
            ))}
          </AnimatePresence>

          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_FILTERS })}
            className="ml-1 rounded px-1.5 py-0.5 text-caption font-medium text-fg-3 transition-colors hover:text-accent"
          >
            Clear all
          </button>
        </div>
      )}

      {/* --- expanded panel --- */}
      {/*
       * Height *and* opacity, so the table below is pushed down rather than
       * covered — this is an inline expander, and the whole reason it is not
       * an overlay is that watching the row count move while you tick boxes is
       * the point. `AnimatePresence` is what gives it an exit: without it the
       * panel would slide open and then vanish instantly on close, which reads
       * as a glitch rather than as the same drawer shutting.
       *
       * `height: auto` is measured by Framer, so the panel can contain a
       * category list of any length without a hard-coded height here.
       */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="filter-panel"
            key="filter-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.26, ease: [0.22, 0.61, 0.36, 1] },
              opacity: { duration: 0.18 },
            }}
            className="overflow-hidden border-t border-line bg-recessed"
          >
            <div className="px-4 py-4">
              <FilterPanel
                filters={filters}
                onChange={onChange}
                categories={categories}
                stats={stats}
                section={section}
                demoCounts={demoCounts}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
      className="pointer-events-none absolute right-2 top-1/2 flex h-[18px] min-w-[18px] -translate-y-1/2 items-center justify-center rounded border border-line-2 bg-surface px-1 font-mono text-[11px] leading-none text-fg-4 transition-opacity group-focus-within:opacity-0"
    >
      /
    </span>
  );
}
