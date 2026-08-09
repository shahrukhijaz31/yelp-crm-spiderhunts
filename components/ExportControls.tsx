"use client";

import { useState } from "react";

import ExportTable from "./ExportTable";
import { useLeads } from "./LeadsProvider";
import { countActiveFilters } from "@/lib/filters";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_HINTS,
  EXPORT_FORMAT_LABELS,
  exportFilename,
  runExport,
  type ExportFormat,
} from "@/lib/exportLeads";

export type ExportStatus =
  | { state: "idle" }
  | { state: "working" }
  | { state: "done"; filename: string }
  | { state: "error"; message: string };

/**
 * Pick rows, pick a format, download. Exporting happens only on this screen,
 * from this screen's own filters — the worklist's tab and filters have no say.
 *
 * There is no scope selector any more, because it was a trap: with "All leads"
 * chosen, ticking rows changed nothing and the file quietly contained
 * everything. The rule is now one sentence that nothing can override —
 *
 *     ticked rows win; with nothing ticked, the filtered list is written.
 *
 * All three original scopes remain reachable: tick rows for a selection,
 * filter for a subset, clear both for the whole list.
 */
export default function ExportControls() {
  const {
    today,
    leads,
    exportFilters,
    exportVisibleLeads,
    selectedIds,
    selectedLeads,
    toggleSelected,
    setSelection,
    clearSelection,
  } = useLeads();

  const [format, setFormat] = useState<ExportFormat>("csv");
  const [status, setStatus] = useState<ExportStatus>({ state: "idle" });

  const ticked = selectedLeads;
  const listed = exportVisibleLeads;
  const filterCount = countActiveFilters(exportFilters);

  /** The rows that will actually be written. Ticks always win. */
  const rows = ticked.length > 0 ? ticked : listed;

  /** Ticked rows the filters are hiding — still exported, so say so. */
  const hiddenTicked =
    ticked.length - listed.filter((lead) => selectedIds.has(lead.id)).length;

  const scope =
    ticked.length > 0 ? "selected" : filterCount > 0 ? "filtered" : "all";

  async function run() {
    setStatus({ state: "working" });
    try {
      const filename = await runExport({ leads: rows, format, scope, today });
      setStatus({ state: "done", filename });
    } catch (error) {
      setStatus({
        state: "error",
        message:
          error instanceof Error ? error.message : "The export could not be created.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <section>
        <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="eyebrow">Rows</h2>
          <p className="text-ui text-fg-3">
            Tick rows to export just those. With nothing ticked, everything
            listed is exported.
          </p>
        </div>

        <ExportTable
          leads={listed}
          today={today}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onToggleAll={(selectAll) => {
            const ids = new Set(selectedIds);
            for (const lead of listed) {
              if (selectAll) ids.add(lead.id);
              else ids.delete(lead.id);
            }
            setSelection(ids);
          }}
          emptyMessage="No leads match the filters above."
        />

        {hiddenTicked > 0 && (
          <p className="mt-2 text-caption text-warning">
            <span className="tnum font-mono">{hiddenTicked}</span> ticked row
            {hiddenTicked === 1 ? " is" : "s are"} hidden by the filters above —
            still included in the file.
          </p>
        )}
      </section>

      <section>
        <h2 className="eyebrow mb-2.5">Format</h2>
        <div className="grid grid-cols-3 gap-2">
          {EXPORT_FORMATS.map((candidate) => {
            const active = candidate === format;
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  setFormat(candidate);
                  setStatus({ state: "idle" });
                }}
                // A picked format is stated three ways — accent border, accent
                // fill, accent label — plus a soft halo, because this choice
                // decides what lands in the download and is worth being
                // unmistakable about.
                className={`panel-lift spotlight rounded-lg border px-3.5 py-3 text-left ${
                  active
                    ? "edge-accent relative border-accent-line bg-accent-soft"
                    : "border-line bg-surface hover:border-line-2 hover:bg-hover"
                }`}
              >
                <span
                  className={`text-ui font-semibold ${active ? "text-accent" : "text-fg"}`}
                >
                  {EXPORT_FORMAT_LABELS[candidate]}
                </span>
                <p className="mt-1 text-caption leading-snug text-fg-3">
                  {EXPORT_FORMAT_HINTS[candidate]}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {/* One unambiguous statement of what pressing the button will produce. */}
      <section className="panel px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-ui text-fg">
            {ticked.length > 0 ? (
              <>
                Exporting the{" "}
                <span className="tnum font-mono font-medium text-accent">
                  {ticked.length}
                </span>{" "}
                ticked row{ticked.length === 1 ? "" : "s"}.
              </>
            ) : (
              <>
                Exporting all{" "}
                <span className="tnum font-mono font-medium">{listed.length}</span>{" "}
                row{listed.length === 1 ? "" : "s"} listed
                {filterCount > 0
                  ? ` (${filterCount} filter${filterCount === 1 ? "" : "s"} applied)`
                  : ` — the full list of ${leads.length}`}
                .
              </>
            )}
          </p>

          {ticked.length > 0 && (
            <button
              type="button"
              onClick={clearSelection}
              className="rounded text-caption text-fg-3 underline decoration-line-2 underline-offset-4 transition-colors hover:text-fg"
            >
              Clear ticks
            </button>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <p className="font-mono text-caption text-fg-3">
              {exportFilename(scope, format, today)}
            </p>
            <button
              type="button"
              onClick={run}
              disabled={rows.length === 0 || status.state === "working"}
              className="ui-btn ui-btn-primary"
            >
              <DownloadIcon />
              {status.state === "working"
                ? "Preparing…"
                : `Export ${rows.length} lead${rows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>

        {status.state === "done" && (
          <p
            role="status"
            className="mt-3 rounded-md border border-success-line bg-success-bg px-3 py-2 text-caption text-success"
          >
            Downloaded <span className="font-mono">{status.filename}</span>.
          </p>
        )}
        {status.state === "error" && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-caption text-danger"
          >
            {status.message}
          </p>
        )}
      </section>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        d="M8 2v9m0 0 3.5-3.5M8 11 4.5 7.5M2.5 12.5v1A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
