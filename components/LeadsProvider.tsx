"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { usePortalStats } from "./PortalStatsProvider";
import { useLeadEditor } from "./useLeadEditor";
import { cleanLeads } from "@/lib/cleanLeads";
import {
  EMPTY_FILTERS,
  matchesFilters,
  weekBounds,
  type LeadFilters,
} from "@/lib/filters";
import { computeStats, todayIso, type LeadStats } from "@/lib/leadUtils";
import { isInView, type WorklistView } from "@/lib/views";
import type { Lead, LeadEditableFields } from "@/lib/types";

/**
 * The whole-table store, for the screens whose job actually is the whole table.
 *
 * It was mounted once in the portal layout, so every route — the worklist
 * included — was handed every lead. Pagination ended that: the worklist reads
 * a page at a time from `GET /api/leads` and never mounts this. What is left
 * are the four screens that genuinely need the full set and each mount it for
 * themselves:
 *
 *   /export    writes every matching row to a file
 *   /meetings  derives the agenda from the lead set (`lib/meetings.ts`)
 *   /reports   aggregates across all of it
 *   /import    swaps the set wholesale after an upload
 *
 * Per-route rather than shared has one visible consequence: the export view's
 * filters no longer survive a trip to another screen and back. That is a fair
 * price for `/settings` no longer downloading several thousand leads to render
 * a page with no leads on it.
 *
 * The export view keeps **separate** filter state from everything else and
 * always did. Sharing it meant the rows offered for export silently depended on
 * which tab happened to be open on another screen.
 *
 * `updateLead` is the mutation path for these screens; the worklist uses the
 * same `useLeadEditor` hook over its own page. It writes to state first and to
 * Postgres after, so the table stays instant while the change is saved for
 * real; a failed save puts the old value back.
 */
interface LeadsContextValue {
  leads: Lead[];
  today: string;
  stats: LeadStats;

  // Worklist workspace — read by the worklist only.
  view: WorklistView;
  setView: (view: WorklistView) => void;
  filters: LeadFilters;
  setFilters: (filters: LeadFilters) => void;
  /** Leads passing the worklist's tab *and* its filters. */
  visibleLeads: Lead[];

  // Export workspace — read by the export view only. No tab, no worklist input.
  exportFilters: LeadFilters;
  setExportFilters: (filters: LeadFilters) => void;
  /** Leads passing the export view's own filters. */
  exportVisibleLeads: Lead[];

  // Row selection, used only by the export view.
  selectedIds: ReadonlySet<string>;
  selectedLeads: Lead[];
  toggleSelected: (id: string) => void;
  setSelection: (ids: Iterable<string>) => void;
  clearSelection: () => void;

  updateLead: (id: string, changes: Partial<LeadEditableFields>) => void;
  replaceLeads: (leads: Lead[]) => void;
}

const LeadsContext = createContext<LeadsContextValue | null>(null);

/** Poll the clock so the "due today" view is still correct after midnight. */
function subscribeToDayChange(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

export function LeadsProvider({
  initialLeads,
  serverToday,
  children,
}: {
  initialLeads: Lead[];
  serverToday: string;
  children: React.ReactNode;
}) {
  // Clean at every entry point, not just the CSV path: whatever the source —
  // sample data today, a database read tomorrow — state only ever holds leads
  // with a dialable, unique phone number. `cleanLeads` is idempotent, so a
  // second pass over already-clean data is free.
  const [leads, setLeads] = useState<Lead[]>(() => cleanLeads(initialLeads).leads);
  const [view, setView] = useState<WorklistView>("all");
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [exportFilters, setExportFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  // "Today" comes from the server for the SSR/hydration render, then from the
  // agent's own clock — so callback highlighting uses their timezone, and a
  // portal left open overnight rolls over on its own.
  const today = useSyncExternalStore(subscribeToDayChange, todayIso, () => serverToday);

  // The optimistic write/rollback used to be spelled out here. It moved to
  // `useLeadEditor` when the worklist stopped reading this store and needed the
  // same behaviour over its own page — see the note in that file.
  const updateLead = useLeadEditor(leads, setLeads);

  // Called with the rows the upload route stored, so this is a state swap only
  // — the write already happened server-side.
  const replaceLeads = useCallback((next: Lead[]) => {
    setLeads(cleanLeads(next).leads);
    // Ids belong to the old dataset; keeping them would silently export rows
    // that no longer exist.
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setSelection = useCallback(
    (ids: Iterable<string>) => setSelectedIds(new Set(ids)),
    [],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const bounds = useMemo(() => weekBounds(today), [today]);

  const visibleLeads = useMemo(
    () =>
      leads.filter(
        (lead) =>
          isInView(lead, view, today) && matchesFilters(lead, filters, today, bounds),
      ),
    [leads, view, filters, today, bounds],
  );

  // Filters only — deliberately not `isInView`, so the worklist's tab has no
  // say in what the export view offers.
  const exportVisibleLeads = useMemo(
    () => leads.filter((lead) => matchesFilters(lead, exportFilters, today, bounds)),
    [leads, exportFilters, today, bounds],
  );

  const selectedLeads = useMemo(
    () => leads.filter((lead) => selectedIds.has(lead.id)),
    [leads, selectedIds],
  );

  const stats = useMemo(() => computeStats(leads, today), [leads, today]);

  // These screens still hold every lead, so they can still count them exactly
  // and instantly — including an optimistic edit that has not reached Postgres
  // yet. Pushing that up keeps the nav bar's counters as live here as they were
  // before the layout stopped loading leads. The store ignores an unchanged
  // set, so this settles after one write rather than looping.
  const { setStats } = usePortalStats();
  useEffect(() => {
    setStats(stats);
  }, [stats, setStats]);

  const value = useMemo<LeadsContextValue>(
    () => ({
      leads,
      today,
      stats,
      view,
      setView,
      filters,
      setFilters,
      visibleLeads,
      exportFilters,
      setExportFilters,
      exportVisibleLeads,
      selectedIds,
      selectedLeads,
      toggleSelected,
      setSelection,
      clearSelection,
      updateLead,
      replaceLeads,
    }),
    [
      leads,
      today,
      stats,
      view,
      filters,
      visibleLeads,
      exportFilters,
      exportVisibleLeads,
      selectedIds,
      selectedLeads,
      toggleSelected,
      setSelection,
      clearSelection,
      updateLead,
      replaceLeads,
    ],
  );

  return <LeadsContext.Provider value={value}>{children}</LeadsContext.Provider>;
}

export function useLeads(): LeadsContextValue {
  const context = useContext(LeadsContext);
  if (!context) throw new Error("useLeads must be used inside <LeadsProvider>");
  return context;
}
