import { prisma } from "./prisma";

/**
 * The workstations an agent has connected, as their own screen sees them.
 *
 * Read server-side and passed down as props, the way `/downloads` does it, so
 * there is no `GET /api/account/workstations` to exist and no endpoint that
 * could be asked about somebody else. The only argument is a user id the caller
 * already resolved from the session.
 *
 * This is the remedy half of the sliding refresh window (see
 * `lib/monitorAuth.ts`): a connection that renews itself for as long as it is
 * used needs somewhere a person can look at it and end it. Without this screen
 * the sliding window would be a straight loss, which is why the two shipped
 * together.
 */

/** One connected workstation. Six display fields and nothing else. */
export interface WorkstationCard {
  /** `monitor_devices.id`, so the panel can post a disconnect back. */
  id: string;
  /** What the machine calls itself. A label, never authorization input. */
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  connectedAt: string;
  /** The last authenticated request from it, within a minute's throttle. */
  lastSeenAt: string;
}

/**
 * Every live workstation for one agent, newest first.
 *
 * Revoked rows are left out. They are kept in the table for a while as the
 * trace that a device was disconnected, but a list of machines you can
 * disconnect should contain only machines that are connected — a greyed-out
 * row for something already dealt with is noise on the one screen that exists
 * to make a real one obvious.
 */
export async function listWorkstationsFor(userId: string): Promise<WorkstationCard[]> {
  const rows = await prisma.monitorDevice
    .findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
      select: {
        id: true,
        deviceName: true,
        platform: true,
        appVersion: true,
        createdAt: true,
        lastSeenAt: true,
      },
    })
    .catch(() => []);

  return rows.map((row) => ({
    id: row.id,
    deviceName: row.deviceName,
    platform: row.platform,
    appVersion: row.appVersion,
    connectedAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}
