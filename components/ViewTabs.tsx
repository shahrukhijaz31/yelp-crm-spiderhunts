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
                ? "font-semibold text-fg"
                : "font-medium text-fg-3 hover:bg-hover hover:text-fg-2"
            }`}
          >
            {WORKLIST_VIEW_LABELS[candidate]}
            {/* Sized and coloured to sit *inside* the tab rather than beside
                it: no border, and on inactive tabs it tracks the label's own
                colour so the pair reads as one thing. */}
            <span
              className={`tnum rounded px-1.5 py-0.5 font-mono text-meta font-medium transition-colors ${
                active
                  ? "bg-accent text-on-accent"
                  : "bg-rail text-fg-3 group-hover:text-fg-2"
              }`}
            >
              {counts[candidate]}
            </span>
            <span
              aria-hidden="true"
              className={`absolute inset-x-0 -bottom-px h-[2px] transition-colors ${
                active ? "bg-accent" : "bg-transparent"
              }`}
            />
          </button>
        );
      })}

      <button
        type="button"
        onClick={onToggleBreakdown}
        aria-expanded={breakdownOpen}
        className="ml-auto mb-1.5 flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-caption font-medium text-fg-3 transition-colors hover:border-line-2 hover:bg-hover hover:text-fg-2"
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