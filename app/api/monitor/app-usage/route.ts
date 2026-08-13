import { recordAppUsage } from "@/lib/appUsage";
import { AppUsageError } from "@/lib/appUsageRules";
import { monitorDevice } from "@/lib/monitorAuth";

/**
 * POST /api/monitor/app-usage — a workstation reports one foreground segment.
 *
 * JSON, like the activity route next door and for the same reason: this body is
 * five small fields and no binary, so multipart would be an envelope around
 * nothing.
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
 *                       is what satisfies "authenticated Agent role" without a
 *                       second role check that could disagree. It also returns
 *                       the device id, which is what `monitor_device_id` is
 *                       written from.
 *   this route          the body is present and is JSON.
 *   `recordAppUsage`    there is an active work session, and the segment's
 *                       names, timestamps and duration are believable
 *                       (`lib/appUsageRules.ts`).
 *
 * ---------------------------------------------------------------------------
 * Authorization is not in the body, and could not be
 * ---------------------------------------------------------------------------
 * `userId`, `agentId` and `workSessionId` are not read from the request — not
 * ignored after being read, but never taken from it at all. The user comes from
 * the device row the bearer token resolved to, the work session from the
 * portal's own `getActiveWorkSession`, and the device from the credential
 * itself. A client that sends those fields is sending fields nothing reads.
 *
 * **Device ownership needs no check of its own**, for the reason the screenshot
 * and activity routes both give: the device row *is* the credential, so "does
 * this device belong to this user" cannot be false.
 *
 * ---------------------------------------------------------------------------
 * Retries
 * ---------------------------------------------------------------------------
 * A retry of a segment already stored answers **200** with `duplicate: true` and
 * the row the server holds; a first delivery answers **201**. Both are
 * successes. The protection is the unique index on `client_key`, so it holds
 * under concurrency because Postgres enforces it rather than a read-then-write
 * in application code.
 *
 * A key already used by *another account* is a **409** `client_key_conflict`
 * rather than a duplicate — see the note in `lib/appUsage.ts` for why the two
 * must not be answered the same way.
 *
 * ---------------------------------------------------------------------------
 * Failure handling, and no rate limit
 * ---------------------------------------------------------------------------
 * Every refusal is final and typed, and none of them asks the client to build a
 * queue: a 409 (no shift), a 422 (implausible segment) and a 401 (revoked
 * device) all mean "drop this segment and carry on". The only case worth
 * retrying is a network failure or a 5xx, which is what `clientKey` makes safe.
 *
 * The screenshot route's rate limit is deliberately not copied here, for the
 * reason the activity route states: a screenshot is an unbounded write of a file
 * on disk, whereas this is one narrow row whose duplicates the unique index
 * already refuses and whose timestamps must end within fifteen minutes of the
 * server's clock — so the number of distinct rows a device can create is bounded
 * by the clock rather than by its own restraint.
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
    const usage = await recordAppUsage({
      user: auth.user,
      deviceId: auth.deviceId,
      body,
    });

    return Response.json(
      {
        ok: true,
        /** True when this was a retry of a segment already stored. */
        duplicate: !usage.created,
        usage: {
          id: usage.id,
          processName: usage.processName,
          applicationName: usage.applicationName,
          startedAt: usage.startedAt,
          endedAt: usage.endedAt,
          /**
           * The server's figure, derived from the two timestamps. Sent back so
           * a workstation can log what was actually recorded rather than what
           * it proposed.
           */
          durationSeconds: usage.durationSeconds,
          workSessionId: usage.workSessionId,
        },
      },
      { status: usage.created ? 201 : 200, headers: noStore },
    );
  } catch (error) {
    if (error instanceof AppUsageError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }

    console.error("POST /api/monitor/app-usage failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not record that app usage. Try again in a moment.",
      },
      { status: 500, headers: noStore },
    );
  }
}
