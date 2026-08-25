"use client";

import { useMemo, useState } from "react";

import ExportControls from "./ExportControls";
import FilterToolbar from "./FilterToolbar";
import { useLeads } from "./LeadsProvider";
import { collectCategories, collectLocations } from "@/lib/filters";
import { EXPORT_COLUMN_HEADERS } from "@/lib/exportLeads";

/**
 * The Export view — self-contained by design.
 *
 * Its filters are its own: changing them here does not touch the worklist, and
 * the worklist's tab and filters do not touch what is listed here. Nothing
 * about an export depends on the state of another screen.
 */
export default function ExportPanel() {
  const { leads, stats, exportFilters, setExportFilters, exportVisibleLeads } =
    useLeads();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const categories = useMemo(() => collectCategories(leads), [leads]);
  // Counted from the leads this screen already holds rather than fetched:
  // Export is the one view with every matching row in memory, so asking the
  // server to group what is sitting in an array here would be a round trip
  // for an answer it can compute. Same reasoning as `collectCategories`.
  const locations = useMemo(() => collectLocations(leads), [leads]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-7">
      <header>
        <h1 className="page-title">Export leads</h1>
        <p className="mt-3 page-intro">
          Narrow the list, tick the rows you want, and download them as a
          spreadsheet or a printable call sheet. These filters belong to this
          screen alone — the worklist has no say in what is exported.
        </p>
      </header>

      <section>
        <h2 className="eyebrow mb-2">Narrow the list</h2>
        <FilterToolbar
          filters={exportFilters}
          onChange={setExportFilters}
          categories={categories}
          locations={locations}
          stats={stats}
          shown={exportVisibleLeads.length}
          open={filtersOpen}
          onToggleOpen={() => setFiltersOpen((open) => !open)}
        />
      </section>

      <ExportControls />

      <section className="panel px-5 py-4">
        <h2 className="eyebrow">Columns included</h2>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {EXPORT_COLUMN_HEADERS.map((header) => (
            <li
              key={header}
              className="rounded border border-line bg-recessed px-2 py-1 font-mono text-caption text-fg-2"
            >
              {header}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-ui leading-relaxed text-fg-3">
          CSV and Excel carry every column above. The PDF is a landscape call
          sheet — it drops the listing URL, source, rating and owner so the
          columns an agent reads while dialling stay legible on paper.
        </p>
      </section>
    </div>
  );
}
