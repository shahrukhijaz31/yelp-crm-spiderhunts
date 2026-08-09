"use client";

import {
  WORKLIST_VIEWS,
  WORKLIST_VIEW_LABELS,
  type WorklistView,
} from "@/lib/views";

/**
 * View switching, not filtering. The tabs sit on the page's baseline rule and
 * the active one is joined to the panel below it by an accent underline, so
 * the table reads as *the contents of this tab* rather than a filtered list.
 */
export default function ViewTabs({
  view,
  counts,
  onChange,
  breakdownOpen,
  onToggleBreakdown,
}: {
  view: WorklistView;
  counts: Record<WorklistView, number>;
  onChange: (view: WorklistView) => void;
  breakdownOpen: boolean;
  onToggleBreakdown: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Lead views"
      className="flex items-end gap-1 border-b border-line"
    >
      {WORKLIST_VIEWS.map((candidate) => {
        const active = candidate === view;
        return (
          <button
            key={candidate}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(candidate)}
            // Three signals separate the active tab, not one: full-contrast
            // ink against fg-3, semibold against medium, and the accent rule
            // below it. Any single one of them is easy to miss at a glance.
            className={`group relative flex items-center gap-2 rounded-t-lg px-3.5 pb-2.5 pt-2 text-ui transition-colors ${
              active
                ? // The active tab is joined to the panel below it: a faint
                  // upward gradient makes the tab and the table read as one
                  // surface, which is the whole claim a tab strip makes.
                  "bg-gradient-to-b from-transparent to-[var(--c-surface)] font-semibold text-fg"
                : "font-medium text-fg-3 hover:bg-hover hover:text-fg-2"
            }`}
          >
            {WORKLIST_VIEW_LABELS[candidate]}
            {/* Sized and coloured to sit *inside* the tab rather than beside
                it: no border, and on inactive tabs it tracks the label's own
                colour so the pair reads as one thing. */}
            <span
              className={`tnum rounded-md px-1.5 py-0.5 font-mono text-meta font-medium transition-colors ${
                active
                  ? "bg-accent text-on-accent shadow-[0_2px_8px_-3px_var(--c-accent)]"
                  : "bg-rail text-fg-3 group-hover:text-fg-2"
              }`}
            >
              {counts[candidate]}
            </span>
            {/* Grows from the centre rather than blinking on, so moving
                between tabs reads as one mark travelling. */}
            <span
              aria-hidden="true"
              data-active={active}
              className="tab-rule absolute inset-x-0 -bottom-px h-[2px] bg-accent"
            />
          </button>
        );
      })}

      <button
        type="button"
        onClick={onToggleBreakdown}
        aria-expanded={breakdownOpen}
        className={`ml-auto mb-1.5 flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-caption font-medium transition-colors ${
          breakdownOpen
            ? "border-line-2 bg-hover text-fg"
            : "border-line text-fg-3 hover:border-line-2 hover:bg-hover hover:text-fg-2"
        }`}
      >
        Breakdown
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`h-3 w-3 transition-transform ${breakdownOpen ? "rotate-180" : ""}`}
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
      </button>
    </div>
  );
}