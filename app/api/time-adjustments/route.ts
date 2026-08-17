import { apiAdmin } from "@/lib/authz";
import { AdjustmentError, applyTimeAdjustment, listAdjustments } from "@/lib/timeTracking";

/**
 * Manual time corrections. ADMIN only, both verbs.
 *
 *   GET   the audit trail — every correction, newest first
 *   POST  make one
 *
 * ---------------------------------------------------------------------------
 * Why this is not under /api/reports
 * ---------------------------------------------------------------------------
 * It is the only endpoint in this feature that *writes* to `work_sessions`, and
 * reading somebody's hours is a different power from rewriting them. Nesting it
 * under the reporting prefix would mean the policy for a write was inherited
 * from a URL chosen for a screen. It has its own entry in `ADMIN_PREFIXES`
 * instead, so the decision to make it admin-only is one somebody wrote down.
 *
 * ---------------------------------------------------------------------------
 * An agent can never reach this, by three independent mechanisms
 * ---------------------------------------------------------------------------
 *   1. `apiAdmin()` in both handlers — the authoritative check, against the
 *      session row in Postgres, re-reading `role` on every request.
 *   2. `/api/time-adjustments` is an admin prefix in `lib/access.ts`, which
 *      `proxy.ts` applies at the edge.
 *   3. The UI is only rendered on an admin-only page.
 *
 * Only the first is load-bearing. There is deliberately no agent-facing
 * endpoint anywhere in this feature that writes to `work_sessions` or
 * `activity_intervals` — the Monitor's activity route creates intervals and
 * touches nothing else, and the browser heartbeat is unchanged.
 *
 * ---------------------------------------------------------------------------
 * The audit record is not optional
 * ---------------------------------------------------------------------------
 * `applyTimeAdjustment` writes the correction and its audit row in one
 * transaction, so there is no ordering, no failure and no crash that leaves a
 * shift altered with no record of who altered it. The reason is required and is
 * stored verbatim. Nothing in the application updates or deletes a row in
 * `time_adjustments`, and no endpoint exists that could.
 */

const noStore = { "Cache-Control": "private, no-store" } as const;

/** A cuid, or nothing. A filter on an already-authorized read. */
function safeId(raw: string | null): string | null {
  if (!raw || raw === "all") return null;
  return /^[a-z0-9]{1,64}$/i.test(raw) ? raw : null;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;

  try {
    const adjustments = await listAdjustments({
      userId: safeId(params.get("agent")),
      workSessionId: safeId(params.get("session")),
      limit: 100,
    });

    return Response.json({ adjustments }, { headers: noStore });
  } catch (error) {
    console.error("GET /api/time-adjustments failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load the correction history." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await apiAdmin(request);
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

  const payload = (body ?? {}) as Record<string, unknown>;
  const workSessionId = typeof payload.workSessionId === "string" ? payload.workSessionId : "";

  if (!workSessionId) {
    return Response.json(
      { error: "invalid_input", message: "workSessionId is required." },
      { status: 400, headers: noStore },
    );
  }

  try {
    const adjustment = await applyTimeAdjustment(
      // The administrator, from the session row. Never from the body — a
      // correction must be attributable to the account that actually made it,
      // and an `adminId` field in the request would be a way to sign somebody
      // else's name to it.
      auth.id,
      {
        workSessionId,
        startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
        endedAt: typeof payload.endedAt === "string" ? payload.endedAt : null,
        reason: typeof payload.reason === "string" ? payload.reason : "",
      },
    );

    return Response.json({ ok: true, adjustment }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof AdjustmentError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }

    console.error("POST /api/time-adjustments failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not save that correction." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
