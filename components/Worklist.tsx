"use client";

import { useMemo, useState } from "react";

import Breakdown from "./Breakdown";
import FilterToolbar from "./FilterToolbar";
import HeadlineStrip from "./HeadlineStrip";
import LeadTable from "./LeadTable";
import ViewTabs from "./ViewTabs";
import { useLeads } from "./LeadsProvider";
import { collectCategories } from "@/lib/filters";
import { countInView, WORKLIST_VIEWS, WORKLIST_VIEW_HINTS, type WorklistView } from "@/lib/views";

/**
 * The worklist screen: headline strip → tabs → (optional breakdown) → filter
 * toolbar → table.
 *
 * Two layers of narrowing, deliberately separate: the tab picks the *scope*
 * an agent is working ("everything I owe a callback"), and the toolbar filters
 * *within* it. Both live in the store rather than here, so `/export` can offer
 * "the view I'm looking at" without this component handing anything over.
 */
export default function Worklist() {
  const {
    leads,
    today,
    stats,
    view,
    setView,
    filters,
    setFilters,
    visibleLeads,
    updateLead,
  } = useLeads();

  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const categories = useMemo(() => collectCategories(leads), [leads]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        WORKLIST_VIEWS.map((candidate) => [
          candidate,
          countInView(leads, candidate, today),
        ]),
      ) as Record<WorklistView, number>,
    [leads, today],
  );

  return (
    <main className="mx-auto flex w-full max-w-[1760px] flex-1 flex-col px-4 pb-7 sm:px-7">
      <HeadlineStrip stats={stats} />

      <ViewTabs
        view={view}
        counts={counts}
        onChange={setView}
        breakdownOpen={breakdownOpen}
        onToggleBreakdown={() => setBreakdownOpen((open) => !open)}
      />

      {breakdownOpen && (
        <div className="mt-4 rounded-xl border border-line bg-surface px-5 py-4">
          <Breakdown stats={stats} />
        </div>
      )}

      <p className="mt-3 text-caption text-fg-3">{WORKLIST_VIEW_HINTS[view]}</p>

      <div className="mt-2.5">
        <FilterToolbar
          filters={filters}
          onChange={setFilters}
          categories={categories}
          stats={stats}
          shown={visibleLeads.length}
          open={filtersOpen}
          onToggleOpen={() => setFiltersOpen((open) => !open)}
        />
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <LeadTable leads={visibleLeads} today={today} onUpdate={updateLead} />
      </div>
    </main>
  );
}
