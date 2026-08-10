"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import {
  DEFAULT_WORK_STATE,
  type LeadWorkCounts,
  type LeadWorkState,
} from "@/lib/workState";

/**
 * Which lead queue is being worked — New or Called — held for the whole portal
 * shell, because the control that changes it and the screen that answers to it
 * are on opposite sides of the layout.
 *
 * The queue moved out of the worklist panel and into the sidebar, next to
 * Meetings and the rest of the navigation, which is where it belongs: choosing
 * New or Called is choosing *what you are working on today*, the same kind of
 * decision as choosing the worklist over the agenda. But `AppSidebar` lives in
 * the layout and `Worklist` lives in the route, so neither can hold the state
 * for the other. This is the seam between them — the same shape, and mounted in
 * the same place, as {@link PortalStatsProvider}.
 *
 * **Not a URL parameter**, and so not a real navigation. Switching queues keeps
 * the rows on screen and dimmed while one bounded fetch runs, exactly as
 * switching a view tab does; routing it would re-render the entire screen from
 * the server to change one `WHERE` clause. It is the same call this codebase
 * already made for the view tabs and the filter rail, for the same reason —
 * only `page` and `pageSize` are worth a URL, because only they are worth
 * bookmarking.
 *
 * The counts come the other way: the layout seeds them from Postgres, and the
 * worklist replaces them with whatever came back on its last request, so the
 * badges in the rail move the moment an agent saves a call outcome.
 */
interface LeadQueueValue {
  workState: LeadWorkState;
  setWorkState: (next: LeadWorkState) => void;
  /** How many leads are in each queue, workspace-wide. */
  counts: LeadWorkCounts;
  /**
   * Replace the counts. Stable for the life of the provider, and a no-op when
   * the numbers have not moved — the worklist pushes from an effect-driven
   * callback, and a write of an equal-but-fresh object would loop.
   */
  setCounts: (next: LeadWorkCounts) => void;
}

const LeadQueueContext = createContext<LeadQueueValue | null>(null);

export function LeadQueueProvider({
  initialCounts,
  children,
}: {
  initialCounts: LeadWorkCounts;
  children: React.ReactNode;
}) {
  const [workState, setWorkState] = useState<LeadWorkState>(DEFAULT_WORK_STATE);
  const [counts, setCountsState] = useState<LeadWorkCounts>(initialCounts);

  const setCounts = useCallback((next: LeadWorkCounts) => {
    setCountsState((current) =>
      current.new === next.new && current.called === next.called ? current : next,
    );
  }, []);

  const value = useMemo<LeadQueueValue>(
    () => ({ workState, setWorkState, counts, setCounts }),
    [workState, counts, setCounts],
  );

  return <LeadQueueContext.Provider value={value}>{children}</LeadQueueContext.Provider>;
}

export function useLeadQueue(): LeadQueueValue {
  const context = useContext(LeadQueueContext);
  if (!context) {
    throw new Error("useLeadQueue must be used inside <LeadQueueProvider>");
  }
  return context;
}
