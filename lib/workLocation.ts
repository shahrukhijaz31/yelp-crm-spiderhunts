import { TRACKED_ROLES, type Role } from "./access";
import { addDays, workdayStart, type DateRange } from "./performanceRules";
import { prisma } from "./prisma";
import {
  isLocationTracked,
  summariseLocations,
  type DayLocationTotals,
  type PersonLocationTotals,
  type WorkLocation,
  type WorkLocationStatus,
  type WorkLocationSummary,
} from "./workLocationRules";

/**
 * Office or remote, for everybody whose time is tracked (agents and
 * contributors).
 *
 * **Chosen, not detected.** The team works through a VPN in the office and at
 * home alike, so every request reaches the portal from the VPN's address and
 * the network cannot tell the two apart. So the person says where they are: the
 * portal asks at the start of every shift ("Where are you working today?") and
 * they switch from the top-bar badge when they move. A choice belongs to one
 * shift (`users.location_session_id`) and is asked again on the next.
 *
 * **What is recorded.** The two liveness signals a shift already has — the
 * portal heartbeat (once a minute while a tab is open) and every authenticated
 * Monitor request — extend the shift's current stretch in the chosen place;
 * choosing a different place starts a new stretch. Time before the first
 * choice of a shift is not labelled at all rather than guessed.
 *
 * **What it cannot do.** Open, close or lengthen a shift, or change any figure
 * that existed before it. It writes `work_location_segments` and the choice on
 * `users`, and nothing else.
 */

/**
 * How often one person's stretch is written. The Monitor makes several
 * requests a minute; the stretch only needs minute resolution, and this keeps a
 * busy workstation to one write a minute.
 */
const TOUCH_MS = 60_000;

/** Per-process memory of the last write per person, for the throttle above. */
const lastWrite = new Map<string, { at: number; location: WorkLocation }>();

/** The open shift's id, or null when they are not on the clock. */
async function openSessionId(userId: string): Promise<string | null> {
  const session = await prisma.workSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return session?.id ?? null;
}

/** Where they said they are, if they said it for this shift. */
async function choiceFor(userId: string, sessionId: string): Promise<WorkLocation | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { locationOverride: true, locationSessionId: true },
  });
  return row?.locationOverride && row.locationSessionId === sessionId ? row.locationOverride : null;
}

/**
 * Record one signal of life. Returns the status the badge should show — the
 * chosen place, or `needsChoice` when this shift has no choice yet — or null
 * for anyone not tracked.
 *
 * Never throws: this rides on the heartbeat and on Monitor requests, and
 * neither may fail because a bookkeeping write did.
 */
export async function recordPresence(
  user: { id: string; role: Role },
  ip: string,
): Promise<WorkLocationStatus | null> {
  if (!isLocationTracked(user.role)) return null;

  try {
    // Within a minute of the last write nothing needs saying: a new choice
    // clears this entry when it is made. So no read at all on most requests.
    const now = Date.now();
    const last = lastWrite.get(user.id);
    if (last && now - last.at < TOUCH_MS) {
      return { location: last.location, needsChoice: false };
    }

    const sessionId = await openSessionId(user.id);
    if (!sessionId) return { location: null, needsChoice: false };

    const location = await choiceFor(user.id, sessionId);
    if (!location) return { location: null, needsChoice: true };

    const latest = await prisma.workLocationSegment.findFirst({
      where: { workSessionId: sessionId },
      orderBy: { startedAt: "desc" },
      select: { id: true, location: true },
    });

    const at = new Date(now);
    const address = ip === "unknown" ? null : ip;
    if (latest && latest.location === location) {
      await prisma.workLocationSegment.update({
        where: { id: latest.id },
        data: { lastSeenAt: at, ip: address },
      });
    } else {
      await prisma.workLocationSegment.create({
        data: {
          userId: user.id,
          workSessionId: sessionId,
          location,
          manual: true,
          ip: address,
          startedAt: at,
          lastSeenAt: at,
        },
      });
    }

    lastWrite.set(user.id, { at: now, location });
    return { location, needsChoice: false };
  } catch (error) {
    console.error(`Recording work location for ${user.id} failed:`, error);
    return null;
  }
}

/**
 * Where this person is right now, without recording anything — the badge's
 * first paint, before the first heartbeat.
 */
export async function currentLocationStatus(user: {
  id: string;
  role: Role;
}): Promise<WorkLocationStatus | null> {
  if (!isLocationTracked(user.role)) return null;
  try {
    const sessionId = await openSessionId(user.id);
    if (!sessionId) return { location: null, needsChoice: false };
    const location = await choiceFor(user.id, sessionId);
    return { location, needsChoice: location === null };
  } catch {
    return null;
  }
}

export class WorkLocationError extends Error {}

/**
 * Say where you are working, for this shift. Starts the new stretch straight
 * away rather than at the next heartbeat.
 */
export async function setLocationChoice(
  user: { id: string; role: Role },
  ip: string,
  location: WorkLocation,
): Promise<WorkLocationStatus> {
  if (!isLocationTracked(user.role)) {
    throw new WorkLocationError("Location is only tracked for agents and contributors.");
  }
  const sessionId = await openSessionId(user.id);
  if (!sessionId) {
    throw new WorkLocationError("Your shift has not started yet. Reload the page and try again.");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { locationOverride: location, locationSessionId: sessionId },
  });

  lastWrite.delete(user.id);
  return (await recordPresence(user, ip)) ?? { location, needsChoice: false };
}

/** Office and remote time for one person over one window. */
export async function locationSummary(
  userId: string,
  range: Pick<DateRange, "from" | "to">,
): Promise<WorkLocationSummary> {
  const rows = await prisma.workLocationSegment.findMany({
    where: {
      userId,
      startedAt: { lt: range.to },
      lastSeenAt: { gt: range.from },
    },
    orderBy: { startedAt: "asc" },
    select: { id: true, location: true, manual: true, startedAt: true, lastSeenAt: true },
  });
  return summariseLocations(rows, range.from, range.to);
}

/**
 * Office and remote time per person over one window — the Timesheets gauges.
 * Everybody tracked, or one person; people with nothing recorded are absent.
 */
export async function teamLocationTotals(
  range: Pick<DateRange, "from" | "to">,
  userId: string | null,
): Promise<PersonLocationTotals[]> {
  const rows = await prisma.workLocationSegment.findMany({
    where: {
      ...(userId ? { userId } : {}),
      user: { role: { in: [...TRACKED_ROLES] } },
      startedAt: { lt: range.to },
      lastSeenAt: { gt: range.from },
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      userId: true,
      location: true,
      manual: true,
      startedAt: true,
      lastSeenAt: true,
      user: { select: { name: true } },
    },
  });

  // Summarised per person, so overlapping stretches are counted once each —
  // the same arithmetic My time uses.
  const byUser = new Map<string, { name: string; rows: typeof rows }>();
  for (const row of rows) {
    const entry = byUser.get(row.userId) ?? { name: row.user.name, rows: [] };
    entry.rows.push(row);
    byUser.set(row.userId, entry);
  }

  return [...byUser.entries()]
    .map(([id, { name, rows: own }]) => {
      const summary = summariseLocations(own, range.from, range.to);
      return {
        userId: id,
        name,
        officeSeconds: summary.officeSeconds,
        remoteSeconds: summary.remoteSeconds,
      };
    })
    .filter((person) => person.officeSeconds + person.remoteSeconds > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Office and remote time per working day, for the `days` days ending with
 * `lastDay` — the Timesheets day gauges. One person, or everybody tracked added
 * together. Every day is present, oldest first, with zeros for a day nobody
 * worked, so the row of gauges always has one gauge per day.
 *
 * Days are working days (11:00–11:00 Pakistan time, `workdayStart`), the same
 * days the timesheet table below the gauges is grouped by.
 */
export async function dailyLocationTotals(
  lastDay: string,
  days: number,
  userId: string | null,
): Promise<DayLocationTotals[]> {
  const dayList = Array.from({ length: days }, (_, index) => addDays(lastDay, index - (days - 1)));
  const from = workdayStart(dayList[0]);
  const to = workdayStart(addDays(lastDay, 1));

  const rows = await prisma.workLocationSegment.findMany({
    where: {
      ...(userId ? { userId } : {}),
      user: { role: { in: [...TRACKED_ROLES] } },
      startedAt: { lt: to },
      lastSeenAt: { gt: from },
    },
    orderBy: { startedAt: "asc" },
    select: { id: true, userId: true, location: true, manual: true, startedAt: true, lastSeenAt: true },
  });

  const byUser = new Map<string, typeof rows>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

  // Per person and then added up, so one person's overlapping stretches are
  // counted once while two people's time on the same day adds together.
  return dayList.map((day) => {
    const dayFrom = workdayStart(day);
    const dayTo = workdayStart(addDays(day, 1));
    let officeSeconds = 0;
    let remoteSeconds = 0;
    for (const own of byUser.values()) {
      const summary = summariseLocations(own, dayFrom, dayTo);
      officeSeconds += summary.officeSeconds;
      remoteSeconds += summary.remoteSeconds;
    }
    return { day, officeSeconds, remoteSeconds };
  });
}
