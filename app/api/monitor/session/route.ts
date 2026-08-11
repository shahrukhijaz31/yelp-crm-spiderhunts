import { monitorUser } from "@/lib/monitorAuth";
import { capturePolicy } from "@/lib/screenshotPolicy";
import { getActiveWorkSession, getWorkClock } from "@/lib/workSessions";

/**
 * GET /api/monitor/session — who this workstation belongs to, and whether that
 * agent is currently on the clock.
 *
 * The Monitor's only routine request. It answers the two questions the desktop
 * status screen asks and nothing else, and it is **strictly read-only with
 * respect to the work session**: `getWorkClock` runs one aggregate and one
 * lookup, and writes nothing. Polling this a thousand times does not create a
 * shift, extend a shift, or move `last_seen_at` on one.
 *
 * That is the whole reason this is not `POST /api/work-session/heartbeat`. The
 * heartbeat *is* a write — it is a browser saying "I am still open", and it will
 * open a session if none exists. Pointing the desktop client at it would mean
 * the Monitor starting an agent's shift by launching, which is exactly what the
 * requirements forbid and what the portal's own design assumes cannot happen.
 * The portal decides when an agent is working; this endpoint reports it.
 *
 * `active` is derived from the same `startedAt` the portal's own clock reads, so
 * the tray and the browser cannot disagree about whether a shift is running.
 *
 * ---------------------------------------------------------------------------
 * It also carries the screenshot cadence
 * ---------------------------------------------------------------------------
 * `screenshotPolicy` is the min/max the workstation draws its random capture
 * delay from. It rides on this response rather than an endpoint of its own
 * because the client already polls this once a minute, and because the cadence
 * is only meaningful alongside the work-session state it depends on.
 *
 * **The server owns those numbers** (`lib/screenshotPolicy.ts`). An agent
 * cannot change how often their screen is photographed by editing anything on
 * their own machine; the client treats its built-in 10–30 minutes purely as a
 * fallback for a portal it has not reached yet, and replaces it on every poll.
 *
 * Two seconds-valued integers is the whole of it. No secret is exposed here —
 * these are timings, and the agent is entitled to know monitoring is happening.
 * What they are deliberately *not* told is the schedule itself: the delay is
 * drawn on the workstation, is never displayed, and is never sent back.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await monitorUser(request);
  if (auth instanceof Response) return auth;

  let clock;
  let active;
  try {
    /*
     * Two reads, both read-only, both already used by the portal itself.
     *
     * `getActiveWorkSession` is here only for the shift's **id**, which the
     * clock does not carry: the desktop client stamps it onto a screenshot's
     * metadata so a capture can later be attributed to the shift it happened
     * during. Nothing about work-session behaviour changes — this opens,
     * extends and closes nothing, exactly as before.
     */
    [clock, active] = await Promise.all([
      getWorkClock(auth.id),
      getActiveWorkSession(auth.id),
    ]);
  } catch (error) {
    console.error("GET /api/monitor/session: could not read the work clock:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the server. Try again in a moment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Read after the database work, and never allowed to fail it: this is
  // environment parsing with a documented fallback for every value.
  const policy = capturePolicy();

  return Response.json(
    {
      ok: true,
      user: {
        id: auth.id,
        name: auth.name,
        email: auth.email,
        username: auth.username,
        role: auth.role,
      },
      workSession: {
        /** True while a shift is running. Null `startedAt` means no shift. */
        active: clock.startedAt !== null,
        /**
         * `work_sessions.id` for the running shift, or null. Not displayed —
         * it is what a later screenshot is attributed to.
         */
        id: active?.id ?? null,
        startedAt: clock.startedAt,
        /**
         * Seconds in shifts that have already *ended* today. The client adds
         * the running one live, from `startedAt` and `serverNow`, so the two
         * halves cannot double-count.
         */
        completedSecondsToday: clock.completedSecondsToday,
        todayStart: clock.todayStart,
      },
      /**
       * The capture cadence this workstation must use, in seconds. Read fresh
       * on every poll, so changing it on the server takes effect on every
       * connected workstation within a minute without a client release.
       */
      screenshotPolicy: {
        minIntervalSeconds: policy.minIntervalSeconds,
        maxIntervalSeconds: policy.maxIntervalSeconds,
      },
      /** For clock-skew correction on a workstation whose time is wrong. */
      serverNow: clock.serverNow,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
