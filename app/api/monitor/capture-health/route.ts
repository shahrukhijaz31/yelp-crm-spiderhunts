import { recordCaptureHealth } from "@/lib/captureHealth";
import { isCaptureReportedReason } from "@/lib/captureHealthRules";
import { monitorDevice } from "@/lib/monitorAuth";

/**
 * POST /api/monitor/capture-health — a workstation reports the outcome of its
 * last screenshot cycle.
 *
 * ---------------------------------------------------------------------------
 * Why this endpoint exists, and why it is not the control
 * ---------------------------------------------------------------------------
 * Screenshot capture could be switched off silently by the person being
 * monitored: a deny ACE on the capture directory makes the write fail, the cycle
 * returns `write-failed` before it reaches the upload, and nothing was ever sent
 * here. Meanwhile activity, app-usage and the device heartbeat all continued, so
 * the shift looked healthy.
 *
 * **The fix for that is the absence of screenshots, not this route.** The
 * dashboard compares the newest screenshot against the cadence the server itself
 * configured (`lib/captureHealthRules.ts`), and that comparison cannot be forged
 * — there is nothing a tampered client can send that makes a missing row appear.
 *
 * This route supplies the *reason*, which is a diagnostic and is trusted exactly
 * as far as a label. Without it the gap alone is unactionable: a workstation
 * locked over a long lunch legitimately produces no screenshots and is
 * indistinguishable from a blocked directory, and an alert that fires on both is
 * an alert nobody reads. With it, an administrator sees `write-failed` versus
 * `locked` — and sees the interesting third case, a client insisting `ok` while
 * nothing arrives, which the dashboard flags outright.
 *
 * ---------------------------------------------------------------------------
 * Why a POST rather than a field on the session poll
 * ---------------------------------------------------------------------------
 * `GET /api/monitor/session` is read-only by construction, and that is a property
 * worth keeping: it is what guarantees polling cannot change an agent's recorded
 * day. Hanging a write off it would quietly cost that. This is the smallest thing
 * that does not: one authenticated write, one column pair, no new authentication
 * mechanism — `monitorDevice()` is the same guard the other three monitor routes
 * open with.
 *
 * ---------------------------------------------------------------------------
 * What is read from the body
 * ---------------------------------------------------------------------------
 * One field: `status`, validated against a fixed list. Nothing identifying —
 * `userId`, `deviceId` and `workSessionId` are not read, and could not be: the
 * device comes from the bearer token, so a workstation cannot file a health
 * report against another agent's device. The instant is the server's own clock,
 * never a client-supplied timestamp.
 *
 * Always answers 204 on a valid report. There is nothing for the client to do
 * with a richer answer, and a workstation must never change its capture behaviour
 * because of what this route said.
 */

const noStore = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request): Promise<Response> {
  const auth = await monitorDevice(request);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: noStore },
    );
  }

  const status = (body as { status?: unknown } | null)?.status;

  if (!isCaptureReportedReason(status)) {
    return Response.json(
      {
        error: "invalid_status",
        message: "status must be one of the known capture outcomes.",
      },
      { status: 400, headers: noStore },
    );
  }

  await recordCaptureHealth(auth.deviceId, status);

  return new Response(null, { status: 204, headers: noStore });
}
