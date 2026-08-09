"use client";

import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";

import {
  WORKLIST_VIEWS,
  WORKLIST_VIEW_LABELS,
  type WorklistView,
} from "@/lib/views";

/**
 * The worklist's view switcher.
 *
 * **A segmented control, not a tab strip.** The difference is a claim about
 * what these four things are. An underlined tab strip says "these are pages";
 * a segmented control says "these are four ways of looking at one list", which
 * is exactly right — every view here is the same table with a different scope,
 * and switching between them does not navigate anywhere.
 *
 * **The pill travels.** It is a single element shared between the four
 * segments via a Framer `layoutId`, so switching view animates it from the old
 * segment to the new one rather than turning one background off and another
 * on. This is the one interaction in the app that genuinely needs a layout
 * library: the pill has to move between two DOM nodes of different widths, and
 * neither a CSS transition (which cannot animate between elements) nor a
 * hand-measured transform (which has to re-measure on every resize, font swap
 * and count change) gets there without more code than this.
 *
 * The travel is a spring, not an ease — a segmented control is a physical
 * metaphor, and a physical thing that slides has momentum. Damping is high
 * enough that it never visibly overshoots.
 *
 * `LayoutGroup` scopes the id, so the Meetings agenda's identical control on
 * another screen can use the same `layoutId` string without the two ever
 * trying to animate into each other.
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
  const reduced = useReducedMotion();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <LayoutGroup id="worklist-views">
        <div role="tablist" aria-label="Lead views" className="segmented">
          {WORKLIST_VIEWS.map((candidate) => {
            const active = candidate === view;
            return (
              <button
                key={candidate}
                role="tab"
                type="button"
                aria-selected={active}
                data-active={active}
                onClick={() => onChange(candidate)}
                className="segment relative"
              >
                {active && (
                  <motion.span
                    aria-hidden="true"
                    layoutId="worklist-view-pill"
                    className="segment-pill"
                    // Reduced motion gets the pill without the journey: it
                    // still marks the right segment, it just appears there.
                    transition={
                      reduced
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }
                    }
                  />
                )}
                {/* Above the travelling pill. Without the stacking context the
                    pill would slide over the labels as it passes them. */}
                <span className="relative z-10">
                  {WORKLIST_VIEW_LABELS[candidate]}
                </span>
                <span className="segment-count tnum relative z-10">
                  {counts[candidate]}
                </span>
              </button>
            );
          })}
        </div>
      </LayoutGroup>

      <button
        type="button"
        onClick={onToggleBreakdown}
        aria-expanded={breakdownOpen}
        className={`ui-btn h-8 px-2.5 text-caption ${
          breakdownOpen ? "ui-btn-secondary" : "ui-btn-ghost"
        }`}
      >
        Breakdown
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-200 ${
            breakdownOpen ? "rotate-180" : ""
          }`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
