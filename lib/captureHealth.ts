import {
  evaluateCaptureHealth,
  type CaptureHealthVerdict,
  type CaptureReportedReason,
} from "./captureHealthRules";
import { prisma } from "./prisma";
import { capturePolicy } from "./screenshotPolicy";
import { STALE_MS } from "./workSessions";

/**
 * Reading screenshot health for the shifts that are open right now.
 *
 * The counterpart to `lib/captureHealthRules.ts`, which owns the thresholds. This
 * owns the queries — and specifically, it owns keeping them to a fixed number
 * regardless of how many agents are working, because this runs on every load of
 * the admin dashboard.
 *
 * ---------------------------------------------------------------------------
 * What is trusted here, and what is not
 * ---------------------------------------------------------------------------
 * The *gap* — how long since a screenshot actually landed — is read from the
 * `screenshots` table and compared against the cadence this server configured.
 * That is the control, and it cannot be forged: a tampered Monitor has nothing it
 * can send to make a missing row appear.
 *
 * The *reason* comes from `monitor_devices.capture_health`, which the workstation
 * wrote, and is therefore a label only. It is never used to decide the state —
 * see the note in `captureHealthRules.ts`.
 */

export interface SessionCaptureHealth extends CaptureHealthVerdict {
  userId: string;
  workSessionId: string;
}

/**
 * Screenshot health for every currently open shift, keyed by user id.
 *
 * Three queries, none of which scales with the number of screenshots or the
 * number of agents:
 *
 *   1. the open shifts (already indexed on `[userId, endedAt]`)
 *   2. the newest screenshot per open shift — a `groupBy` with `_max`, so one row
 *      per shift comes back rather than the screenshots themselves
 *   3. the newest capture-health report per user across their live devices
 *
 * Returns an empty map rather than throwing if anything fails: a dashboard that
 * cannot render because a diagnostic column could not be read is worse than a
 * dashboard that omits one badge.
 */
export async function openSessionCaptureHealth(
  now: Date = new Date(),
): Promise<Map<string, SessionCaptureHealth>> {
  const result = new Map<string, SessionCaptureHealth>();

  try {
    const policy = capturePolicy();

    const sessions = await prisma.workSession.findMany({
      where: { endedAt: null },
      select: { id: true, userId: true, startedAt: true, lastMonitorSeenAt: true },
      orderBy: { startedAt: "asc" },
    });

    if (sessions.length === 0) return result;

    const sessionIds = sessions.map((session) => session.id);
    const userIds = [...new Set(sessions.map((session) => session.userId))];

    const [latestShots, devices] = await Promise.all([
      /*
       * The newest capture per shift. `groupBy` with `_max` rather than fetching
       * rows and reducing in JS: an eight-hour shift can hold dozens of
       * screenshots per agent, and none of them is wanted here — only the
       * instant of the last one.
       */
      prisma.screenshot.groupBy({
        by: ["workSessionId"],
        where: { workSessionId: { in: sessionIds } },
        _max: { capturedAt: true },
      }),
      /*
       * The health reports. Scoped to unrevoked devices, and ordered so the
       * newest report per user wins — an agent with a laptop and a desktop has
       * two device rows, and the shift is being watched by whichever one is
       * actually reporting.
       */
      prisma.monitorDevice.findMany({
        where: { userId: { in: userIds }, revokedAt: null, captureHealthAt: { not: null } },
        select: { userId: true, captureHealth: true, captureHealthAt: true },
        orderBy: { captureHealthAt: "desc" },
      }),
    ]);

    const lastShotBySession = new Map<string, Date | null>();
    for (const row of latestShots) {
      lastShotBySession.set(row.workSessionId, row._max.capturedAt ?? null);
    }

    const reportByUser = new Map<string, { reason: CaptureReportedReason; at: Date }>();
    for (const device of devices) {
      if (reportByUser.has(device.userId)) continue; // newest already taken
      if (!device.captureHealth || !device.captureHealthAt) continue;
      reportByUser.set(device.userId, {
        reason: device.captureHealth as CaptureReportedReason,
        at: device.captureHealthAt,
      });
    }

    for (const session of sessions) {
      // The one-open-session invariant means at most one per user; if a duplicate
      // ever exists, the earliest is the real shift — the same choice
      // `teamTimeTracking` and `collapseDuplicateOpenSessions` make.
      if (result.has(session.userId)) continue;

      const verdict = evaluateCaptureHealth({
        now,
        sessionStartedAt: session.startedAt,
        lastMonitorSeenAt: session.lastMonitorSeenAt,
        lastScreenshotAt: lastShotBySession.get(session.id) ?? null,
        reported: reportByUser.get(session.userId) ?? null,
        // `capturePolicy()` speaks seconds; the rules speak minutes.
        maxIntervalMinutes: policy.maxIntervalSeconds / 60,
        monitorStaleMs: STALE_MS,
      });

      result.set(session.userId, {
        ...verdict,
        userId: session.userId,
        workSessionId: session.id,
      });
    }
  } catch (error) {
    console.error("[capture-health] could not read screenshot health:", error);
  }

  return result;
}

/**
 * Record what a workstation says about its own capture subsystem.
 *
 * Stamped with the server's clock, never a client-supplied instant — the same
 * rule `touchMonitorLiveness` follows, and for the same reason: a doctored system
 * time must not be able to make a stale reason look current.
 *
 * Scoped to the one authenticated device. There is no field in the request that
 * says which device this is about, so a workstation cannot write a health report
 * against somebody else's.
 *
 * Failure is swallowed. This is bookkeeping for a dashboard badge; it must never
 * turn into an error the Monitor has to handle, and it must never be the reason a
 * capture cycle looks like it failed.
 */
export async function recordCaptureHealth(
  deviceId: string,
  reason: CaptureReportedReason,
): Promise<void> {
  await prisma.monitorDevice
    .updateMany({
      where: { id: deviceId, revokedAt: null },
      data: { captureHealth: reason, captureHealthAt: new Date() },
    })
    .catch(() => {
      // Bookkeeping. See the note above.
    });
}
