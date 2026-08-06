"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
 * The app's store, mounted once in the root layout so every route sees the
 * same workspace — `/import` can load a CSV that `/` shows, and `/export` can
 * offer "the view I'm looking at" without the worklist having to hand it over.
 *
 * The worklist and the export view keep **separate** filter state and never
 * read each other's. Sharing them meant the rows offered for export silently
 * depended on which tab happened to be open on another screen.
 *
 * `updateLead` is the only mutation path in the app, which is what let the
 * `PATCH /api/leads/:id` call land in exactly one place. It writes to state
 * first and to Postgres after, so the table stays instant while the change is
 * saved for real; a failed save puts the old value back.
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

  // Kept in step with `leads` so `updateLead` can read the pre-edit values
  // without putting that read inside a state updater, which React may call
  // more than once per commit.
  const leadsRef = useRef(leads);
  leadsRef.current = leads;

  const updateLead = useCallback(
    (id: string, changes: Partial<LeadEditableFields>) => {
      const keys = Object.keys(changes) as (keyof LeadEditableFields)[];
      if (keys.length === 0) return;

      const before = leadsRef.current.find((lead) => lead.id === id);
      if (!before) return;

      // Optimistic: the row repaints on this tick. The agent is on a call and
      // cannot wait a round trip to see the status they just picked.
      setLeads((current) =>
        current.map((lead) => (lead.id === id ? { ...lead, ...changes } : lead)),
      );

      void (async () => {
        let saved = false;
        try {
          const response = await fetch(`/api/leads/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
          });
          saved = response.ok;
          if (!saved) {
            console.error(
              `Saving lead ${id} failed (${response.status}):`,
              await response.text(),
            );
          }
        } catch (error) {
          console.error(`Saving lead ${id} failed:`, error);
        }
        if (saved) return;

        // Roll back — but only the fields this call changed, and only if they
        // still hold what this call wrote. If the agent has since typed
        // something else into the same field, their newer value is the one that
        // matters and a rollback would throw it away.
        setLeads((current) =>
          current.map((lead) => {
            if (lead.id !== id) return lead;
            const untouched = keys.every((key) => Object.is(lead[key], changes[key]));
            if (!untouched) return lead;

            const restored = { ...lead };
            for (const key of keys) {
              // `key` indexes the same field on both objects; the assignment is
              // type-safe by construction but not provable to TS.
              (restored[key] as unknown) = before[key];
            }
            return restored;
          }),
        );
      })();
    },
    [],
  );

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

  const value = useMemo<LeadsContextValue>(
    () => ({
      leads,
      today,
      stats: computeStats(leads, today),
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
