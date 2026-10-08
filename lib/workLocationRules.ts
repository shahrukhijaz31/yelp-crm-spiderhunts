import { isTrackedRole, type Role } from "./access";

/**
 * Office or remote — the vocabulary, and the arithmetic over stored stretches.
 *
 * Pure: no Prisma, so the client components that draw the badge and the
 * breakdown can import it. The database side is `lib/workLocation.ts`.
 */

export const WORK_LOCATIONS = ["office", "remote"] as const;

export type WorkLocation = (typeof WORK_LOCATIONS)[number];

export const WORK_LOCATION_LABELS: Record<WorkLocation, string> = {
  office: "Office",
  remote: "Remote",
};

/**
 * Who is tracked for location: everybody whose time is tracked — agents and
 * contributors (`TRACKED_ROLES`). Both can split a day between the office and
 * home on one laptop, so the network they are on is the signal, and the
 * Timesheets screen shows the split for each of them. Administrators are not
 * tracked at all.
 */
export function isLocationTracked(role: Role): boolean {
  return isTrackedRole(role);
}

/** Office and remote time for one person over one window, for Timesheets. */
export interface PersonLocationTotals {
  userId: string;
  name: string;
  officeSeconds: number;
  remoteSeconds: number;
}

/** How many days the Timesheets day gauges can show. Seven at the least. */
export const LOCATION_DAY_OPTIONS = [7, 14, 30] as const;

/** Office and remote time on one working day (11:00–11:00 Pakistan time). */
export interface DayLocationTotals {
  /** `YYYY-MM-DD`, the working day. */
  day: string;
  officeSeconds: number;
  remoteSeconds: number;
}

/** Where someone is working right now, as the badge shows it. */
export interface WorkLocationStatus {
  /** What they chose for this shift, or null before they have chosen. */
  location: WorkLocation | null;
  /** True when on the clock with no choice yet — the portal asks. */
  needsChoice: boolean;
}

/** One stretch in one place, clipped to the window being reported. */
export interface LocationStretch {
  id: string;
  location: WorkLocation;
  manual: boolean;
  /** ISO instants. */
  startedAt: string;
  endedAt: string;
  seconds: number;
}

export interface WorkLocationSummary {
  officeSeconds: number;
  remoteSeconds: number;
  /** Oldest first. */
  stretches: LocationStretch[];
}

/** A stored stretch, as `summariseLocations` needs it. */
export interface LocationRow {
  id: string;
  location: WorkLocation;
  manual: boolean;
  startedAt: Date;
  lastSeenAt: Date;
}

/**
 * Totals and stretches for one window.
 *
 * Each stretch is clipped to `[from, to)`, so a stretch that began yesterday
 * counts only its part of today. Totals are the *union* of each location's
 * stretches rather than their sum: two signals racing can write overlapping
 * rows for the same place, and the overlap is one stretch of time, not two.
 */
export function summariseLocations(
  rows: LocationRow[],
  from: Date,
  to: Date,
): WorkLocationSummary {
  const stretches: LocationStretch[] = [];
  for (const row of rows) {
    const start = Math.max(row.startedAt.getTime(), from.getTime());
    const end = Math.min(row.lastSeenAt.getTime(), to.getTime());
    if (end <= start) continue;
    stretches.push({
      id: row.id,
      location: row.location,
      manual: row.manual,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      seconds: Math.round((end - start) / 1000),
    });
  }
  stretches.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const totals: Record<WorkLocation, number> = { office: 0, remote: 0 };
  for (const location of WORK_LOCATIONS) {
    let coveredUntil = -Infinity;
    for (const stretch of stretches) {
      if (stretch.location !== location) continue;
      const start = Math.max(new Date(stretch.startedAt).getTime(), coveredUntil);
      const end = new Date(stretch.endedAt).getTime();
      if (end > start) totals[location] += (end - start) / 1000;
      coveredUntil = Math.max(coveredUntil, end);
    }
  }

  return {
    officeSeconds: Math.round(totals.office),
    remoteSeconds: Math.round(totals.remote),
    stretches,
  };
}
