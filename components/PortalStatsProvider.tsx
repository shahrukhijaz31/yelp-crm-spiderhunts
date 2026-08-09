"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { LeadStats } from "@/lib/leadUtils";

/**
 * The workspace-wide counts, held for the whole portal shell.
 *
 * The nav bar shows two of them on every screen, and it used to read them off
 * `LeadsProvider` — which could only offer them because it held every lead in
 * the browser. That is the thing pagination removes, so the counts are now
 * computed by Postgres (`leadStats`), seeded into this store by the portal
 * layout, and *replaced* by whichever screen learns a fresher set:
 *
 *   - the worklist pushes the stats that came back with its page, including
 *     after an inline edit, so the bar still moves when an agent marks a lead;
 *   - `LeadsProvider`, on the screens that do still load every lead, pushes the
 *     figures it derives itself, so those screens keep their instant,
 *     optimistic counters exactly as they were.
 *
 * Kept apart from `LeadsProvider` rather than folded into it because the two
 * now have genuinely different lifetimes: this one lives in the layout and
 * costs an aggregate query, that one is mounted per-route and costs the table.
 */
interface PortalStatsValue {
  stats: LeadStats;
  /**
   * Replace the counts. Stable for the life of the provider, and a no-op when
   * the figures have not actually moved — both callers push from an effect, and
   * either an unstable identity or a write of an equal-but-fresh object would
   * have them re-running each other forever.
   */
  setStats: (stats: LeadStats) => void;
}

const PortalStatsContext = createContext<PortalStatsValue | null>(null);

export function PortalStatsProvider({
  initialStats,
  children,
}: {
  initialStats: LeadStats;
  children: React.ReactNode;
}) {
  const [stats, setStatsState] = useState<LeadStats>(initialStats);

  const setStats = useCallback((next: LeadStats) => {
    setStatsState((current) => (sameStats(current, next) ? current : next));
  }, []);

  const value = useMemo<PortalStatsValue>(
    () => ({ stats, setStats }),
    [stats, setStats],
  );

  return (
    <PortalStatsContext.Provider value={value}>{children}</PortalStatsContext.Provider>
  );
}

export function usePortalStats(): PortalStatsValue {
  const context = useContext(PortalStatsContext);
  if (!context) {
    throw new Error("usePortalStats must be used inside <PortalStatsProvider>");
  }
  return context;
}

/** Value equality over the flat numbers plus the per-status map. */
function sameStats(a: LeadStats, b: LeadStats): boolean {
  if (a === b) return true;
  if (
    a.total !== b.total ||
    a.called !== b.called ||
    a.notCalled !== b.notCalled ||
    a.callbackDueToday !== b.callbackDueToday ||
    a.callbackOverdue !== b.callbackOverdue ||
    a.missingWebsite !== b.missingWebsite
  ) {
    return false;
  }
  const statuses = Object.keys(a.byStatus) as (keyof LeadStats["byStatus"])[];
  return statuses.every((status) => a.byStatus[status] === b.byStatus[status]);
}
