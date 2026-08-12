import { recordActivityInterval } from "@/lib/activity";
import { ActivityError } from "@/lib/activityRules";
import { monitorDevice } from "@/lib/monitorAuth";

/**
 * POST /api/monitor/activity — a workstation reports one interval of aggregate
 * keyboard and mouse activity.
 *
 * JSON, unlike the screenshot upload next door: this body is six small fields
 * and no binary, so multipart would be an envelope around nothing.
 *
 * ---------------------------------------------------------------------------
 * What is checked, and where
 * ---------------------------------------------------------------------------
 *   `monitorDevice()`   the bearer token resolves to a live, unrevoked device,
 *                       and the account behind it is re-read from Postgres — so
 *                       a demoted, disabled or signed-out agent is refused here
 *                       rather than at token expiry. The AGENT-only rule is
 *                       inside that lookup (`checkMonitorEligibility`) and is
 *                       the same one the rest of the monitor API applies, which
 *                       is what satisfies "user is an AGENT where required"
 *                       without a second role check that could disagree.
 *   this route          the body is present and is JSON.
 *   `recordActivity…`   there is an active work session, and the interval's
 *                       timestamps, duration and counts are believable
 *                       (`lib/activityRules.ts`).
 *
 * ---------------------------------------------------------------------------
 * Authorization is not in the body, and could not be
 * ---------------------------------------------------------------------------
 * `userId`, `agentId` and `workSessionId` are not read from the request — not
 * ignored after being read, but never taken from it at all. The user comes from
 * the device row the bearer token resolved to, and the work session from the
 * portal's own `getActiveWorkSession`. A client that sends those fields is
 * sending fields nothing reads.
 *
 * **Device ownership needs no check of its own**, for the same reason the
 * screenshot route gives: the device row *is* the credential, so "does this
 * device belong to this user" cannot be false.
 *
 * ---------------------------------------------------------------------------
 * Retries, and why there is no rate limit here
 * ---------------------------------------------------------------------------
 * A retry of an interval already stored answers **200** with `duplicate: true`
 * and the row the server holds; a first delivery answers **201**. Both are
 * successes, and a client that cannot tell them apart has still behaved
 * correctly — which is the point of an idempotency key.
 *
 * The screenshot route's rate limit is deliberately not copied here. That one
 * exists because a screenshot is an unbounded write: a file on disk, several
 * hundred kilobytes, once per accepted request. An activity interval is one
 * narrow row whose duplicates the unique index already refuses, and whose
 * timestamps must fall inside a fifteen-minute window around the server's clock
 * — so the number of distinct rows a device can create is bounded by the clock
 * rather than by its own restraint. Adding a limiter would mostly succeed at
 * dropping legitimate retries.
 *
 * ---------------------------------------------------------------------------
 * Failure handling
 * ---------------------------------------------------------------------------
 * Every refusal is final and typed, and none of them asks the client to build a
 * queue. A 409 (no shift), a 422 (implausible interval) and a 401 (revoked
 * device) all mean the same thing to the Monitor: drop this interval and carry
 * on. The only case worth retrying is a network failure or a 5xx, which is what
 * `clientKey` makes safe.
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

  try {
    const interval = await recordActivityInterval({ user: auth.user, body });

    return Response.json(
      {
        ok: true,
        /** True when this was a retry of an interval already stored. */
        duplicate: !interval.created,
        interval: {
          id: interval.id,
          startedAt: interval.startedAt,
          endedAt: interval.endedAt,
          durationSeconds: interval.durationSeconds,
          keyboardActivityCount: interval.keyboardActivityCount,
          mouseActivityCount: interval.mouseActivityCount,
          /**
           * The server's figure. Sent back so a workstation can log what was
           * actually recorded rather than what it proposed — the two differ
           * whenever the client's calibration differs from the server's.
           */
          activityPercentage: interval.activityPercentage,
          workSessionId: interval.workSessionId,
        },
      },
      { status: interval.created ? 201 : 200, headers: noStore },
    );
  } catch (error) {
    if (error instanceof ActivityError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }

    console.error("POST /api/monitor/activity failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not record that activity. Try again in a moment.",
      },
      { status: 500, headers: noStore },
    );
  }
}
