import { TRACKED_ROLES, type Role } from "./access";
import type { DateRange } from "./performanceRules";
import { prisma } from "./prisma";
import {
  isLocationTracked,
  summariseLocations,
  type PersonLocationTotals,
  type WorkLocation,
  type WorkLocationStatus,
  type WorkLocationSummary,
} from "./workLocationRules";

/**
 * Office or remote, for everybody whose time is tracked (agents and
 * contributors).
 *
 * A contributor carries one laptop between the office and home, sometimes on
 * the same day, so the machine cannot say where it is — the network can. The
 * office line has a fixed public address (`office_networks`); a request from it
 * is office, a request from anywhere else is remote.
 *
 * **What this observes.** The two liveness signals a shift already has: the
 * portal heartbeat (once a minute while a tab is open) and every authenticated
 * Monitor request. Each one, from a contributor with an open shift, extends the
 * shift's current stretch if the place is unchanged, or starts a new stretch if
 * it moved. No new traffic, nothing for the contributor to press.
 *
 * **What it cannot do.** Open, close or lengthen a shift, or change any figure
 * that existed before it. It writes `work_location_segments` and the two
 * override columns on `users`, and nothing else.
 *
 * **When the network is wrong** — a home VPN that exits at the office, the
 * office line down and a phone hotspot in use — the contributor corrects it
 * from the badge. The correction is held only while the network still reads as
 * it did when they made it (`locationOverrideBasis`), so it lapses by itself
 * when they move and can never outlive the situation it was for.
 *
 * The address used is `clientIp` (`lib/loginThrottle.ts`), which trusts only
 * what nginx wrote. A request whose address cannot be established records
 * nothing rather than guessing.
 */

/** How long the office list is reused before it is read again. */
const OFFICE_CACHE_MS = 60_000;

/**
 * How often one person's stretch is written. The Monitor makes several
 * requests a minute; the stretch only needs minute resolution, and this keeps a
 * busy workstation to one write a minute.
 */
const TOUCH_MS = 60_000;

let officeCache: { at: number; ips: Set<string> } | null = null;

/** Per-process memory of the last write per person, for the throttle above. */
const lastWrite = new Map<string, { at: number; status: WorkLocationStatus }>();

/** The office addresses, cached for a minute. */
async function officeIps(): Promise<Set<string>> {
  if (officeCache && Date.now() - officeCache.at < OFFICE_CACHE_MS) return officeCache.ips;
  const rows = await prisma.officeNetwork.findMany({ select: { ip: true } });
  officeCache = { at: Date.now(), ips: new Set(rows.map((row) => row.ip)) };
  return officeCache.ips;
}

/** Forget the cached list — called when an administrator edits it. */
export function invalidateOfficeNetworks(): void {
  officeCache = null;
  lastWrite.clear();
}

/** `::ffff:39.60.232.90` is how an IPv4 client can appear on a dual-stack socket. */
function canonicalIp(ip: string): string {
  const value = ip.trim().toLowerCase();
  return value.startsWith("::ffff:") && value.includes(".") ? value.slice(7) : value;
}

/**
 * Development only: the address to pretend a request came from.
 *
 * `next dev` has no nginx in front of it, so `clientIp` rightly reads every
 * request as "unknown" and nothing would ever be recorded on a laptop.
 * `DEV_CLIENT_IP` in `.env.local` stands in for it — set it to an office
 * address to see Office, anything else to see Remote. Ignored entirely in
 * production, where only what nginx wrote is believed.
 */
function devIp(ip: string): string {
  if (ip !== "unknown" || process.env.NODE_ENV === "production") return ip;
  return process.env.DEV_CLIENT_IP?.trim() || ip;
}

/** What the network says, or null when the address is unknown. */
export async function detectLocation(ip: string): Promise<WorkLocation | null> {
  if (!ip || ip === "unknown") return null;
  return (await officeIps()).has(canonicalIp(ip)) ? "office" : "remote";
}

/**
 * What is being recorded for this person on this network, applying (or
 * lapsing) their correction. Writes only when a correction has lapsed.
 */
async function resolveStatus(
  userId: string,
  detected: WorkLocation,
): Promise<WorkLocationStatus> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { locationOverride: true, locationOverrideBasis: true },
  });

  if (row?.locationOverride) {
    if (row.locationOverrideBasis === detected) {
      return {
        location: row.locationOverride,
        detected,
        manual: row.locationOverride !== detected,
      };
    }
    // They have moved since they made the correction: it no longer applies.
    await prisma.user.update({
      where: { id: userId },
      data: { locationOverride: null, locationOverrideBasis: null },
    });
  }

  return { location: detected, detected, manual: false };
}

/**
 * Record one signal of life from a contributor. Returns the status the badge
 * should show, or null for anyone not tracked or an unknown address.
 *
 * Never throws: this rides on the heartbeat and on Monitor requests, and
 * neither may fail because a bookkeeping write did.
 */
export async function recordPresence(
  user: { id: string; role: Role },
  ip: string,
): Promise<WorkLocationStatus | null> {
  if (!isLocationTracked(user.role)) return null;
  ip = devIp(ip);

  try {
    const detected = await detectLocation(ip);
    if (!detected) return null;

    // Within a minute of the last write and on the same network, nothing can
    // have changed: a correction clears this entry when it is made, and only a
    // change of network can lapse one. So no read at all on most requests.
    const now = Date.now();
    const last = lastWrite.get(user.id);
    if (last && now - last.at < TOUCH_MS && last.status.detected === detected) {
      return last.status;
    }

    const status = await resolveStatus(user.id, detected);

    const session = await prisma.workSession.findFirst({
      where: { userId: user.id, endedAt: null },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    // Not on the clock: nothing to describe. The badge still says where they
    // are, so a contributor can see it before their shift starts.
    if (!session) {
      lastWrite.set(user.id, { at: now, status });
      return status;
    }

    const latest = await prisma.workLocationSegment.findFirst({
      where: { workSessionId: session.id },
      orderBy: { startedAt: "desc" },
      select: { id: true, location: true, manual: true },
    });

    const at = new Date(now);
    if (latest && latest.location === status.location && latest.manual === status.manual) {
      await prisma.workLocationSegment.update({
        where: { id: latest.id },
        data: { lastSeenAt: at, ip },
      });
    } else {
      await prisma.workLocationSegment.create({
        data: {
          userId: user.id,
          workSessionId: session.id,
          location: status.location,
          manual: status.manual,
          ip,
          startedAt: at,
          lastSeenAt: at,
        },
      });
    }

    lastWrite.set(user.id, { at: now, status });
    return status;
  } catch (error) {
    console.error(`Recording work location for ${user.id} failed:`, error);
    return null;
  }
}

/**
 * Where this person is right now, without recording anything — the badge's
 * first paint, before the first heartbeat.
 */
export async function currentLocationStatus(
  user: { id: string; role: Role },
  ip: string,
): Promise<WorkLocationStatus | null> {
  if (!isLocationTracked(user.role)) return null;
  ip = devIp(ip);
  try {
    const detected = await detectLocation(ip);
    if (!detected) return null;
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { locationOverride: true, locationOverrideBasis: true },
    });
    if (row?.locationOverride && row.locationOverrideBasis === detected) {
      return {
        location: row.locationOverride,
        detected,
        manual: row.locationOverride !== detected,
      };
    }
    return { location: detected, detected, manual: false };
  } catch {
    return null;
  }
}

export class WorkLocationError extends Error {}

/**
 * A contributor correcting where they are. Choosing what the network already
 * says clears the correction. Starts the new stretch straight away rather than
 * at the next heartbeat.
 */
export async function setLocationOverride(
  user: { id: string; role: Role },
  ip: string,
  location: WorkLocation,
): Promise<WorkLocationStatus> {
  if (!isLocationTracked(user.role)) {
    throw new WorkLocationError("Location is only tracked for agents and contributors.");
  }
  ip = devIp(ip);
  const detected = await detectLocation(ip);
  if (!detected) {
    throw new WorkLocationError("Your network address could not be read, so nothing was changed.");
  }

  await prisma.user.update({
    where: { id: user.id },
    data:
      location === detected
        ? { locationOverride: null, locationOverrideBasis: null }
        : { locationOverride: location, locationOverrideBasis: detected },
  });

  lastWrite.delete(user.id);
  return (
    (await recordPresence(user, ip)) ?? { location, detected, manual: location !== detected }
  );
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

/** The office list, for the Settings page. */
export async function listOfficeNetworks() {
  return prisma.officeNetwork.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, ip: true, label: true, createdAt: true },
  });
}
