import { monitorDevice } from "@/lib/monitorAuth";
import { saveScreenshot } from "@/lib/screenshots";
import { releaseUploadSlot, reserveUploadSlot } from "@/lib/screenshotRateLimit";
import { MAX_SCREENSHOT_BYTES, ScreenshotError } from "@/lib/screenshotRules";

/**
 * POST /api/monitor/screenshots — a workstation uploads one desktop capture.
 *
 * `multipart/form-data` with a `file` part carrying the JPEG, plus two advisory
 * text fields (`capturedAt`, `displayId`). Not base64 JSON: that inflates the
 * body by a third and forces the whole image through a string on both ends, for
 * a transport the platform already has.
 *
 * ---------------------------------------------------------------------------
 * What is checked, and where
 * ---------------------------------------------------------------------------
 *   `monitorDevice()`   the bearer token resolves to a live, unrevoked device,
 *                       and the account behind it is re-read from Postgres —
 *                       so a demoted, disabled or signed-out agent is refused
 *                       here rather than at token expiry. The AGENT-only rule
 *                       is inside that lookup (`checkMonitorEligibility`), and
 *                       is the same one the rest of the monitor API applies.
 *   this route          the body is present, is a multipart form, has a file
 *                       part, and is not obviously oversized.
 *   `reserveUploadSlot` this workstation has not already had a screenshot
 *                       accepted inside the current window. See below.
 *   `saveScreenshot()`  there is an active work session, and the bytes are a
 *                       structurally valid JPEG of sane dimensions.
 *
 * ---------------------------------------------------------------------------
 * The rate limit, and where it sits
 * ---------------------------------------------------------------------------
 * One accepted screenshot per monitor device per window (five minutes by
 * default, `lib/screenshotPolicy.ts`). It is claimed *after* the request has
 * been shown to be a plausible upload and *before* anything is stored, so a
 * refusal writes no file and creates no row — it is a 429 and nothing else.
 *
 * It is enforced against the server's own clock and a column only the server
 * writes, so no header, form field or timestamp in the request can move it. And
 * it is not an in-process counter: see `lib/screenshotRateLimit.ts` for why a
 * `Map` would give a device one window per PM2 worker.
 *
 * The refusal carries `Retry-After` and nothing else — no window length, no
 * last-accepted timestamp, no count. The desktop client does not need them: its
 * response to a 429 is to drop the capture and wait for its next scheduled
 * cycle, which is the same thing it does for every other refusal.
 *
 * **Device ownership needs no check of its own.** The device row *is* the
 * credential: the user is read through it, so "does this device belong to this
 * user" cannot be false. There is no user id in the request to compare it
 * against — which is the point.
 *
 * **Nothing identifying is taken from the body.** `userId` comes from the
 * device, `workSessionId` from the portal's own view of that agent's shift, the
 * dimensions from the JPEG, the filename and path from the server. See
 * `lib/screenshots.ts`.
 *
 * The response is deliberately thin — an id and the stored facts. No storage
 * key, no path, no URL: the bytes are not reachable over HTTP in this stage at
 * all, and a viewer in a later stage will read them through a route that checks
 * who is asking.
 */

const noStore = { "Cache-Control": "no-store" } as const;

/** Slack for the multipart envelope, so a file at the limit is not refused by its wrapper. */
const ENVELOPE_SLACK_BYTES = 64 * 1024;

function tooLarge(): Response {
  return Response.json(
    {
      error: "too_large",
      message: `That screenshot is over the ${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)}MB limit.`,
    },
    { status: 413, headers: noStore },
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await monitorDevice(request);
  if (auth instanceof Response) return auth;

  /*
   * Refuse an oversized body before it is buffered. The header is a claim and
   * the real check is on the bytes, but believing it costs nothing and turns a
   * gross misdrop away at the first packet rather than after it has all
   * arrived in memory.
   */
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SCREENSHOT_BYTES + ENVELOPE_SLACK_BYTES
  ) {
    return tooLarge();
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      {
        error: "invalid_body",
        message: 'Expected a multipart form with a "file" field.',
      },
      { status: 400, headers: noStore },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { error: "missing_file", message: "No screenshot in the request." },
      { status: 400, headers: noStore },
    );
  }

  if (file.size > MAX_SCREENSHOT_BYTES) return tooLarge();

  const slot = await reserveUploadSlot(auth.deviceId);
  if (!slot.allowed) {
    return Response.json(
      {
        error: "rate_limited",
        message: "This workstation has already uploaded a screenshot recently.",
        retryAfterSeconds: slot.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { ...noStore, "Retry-After": String(slot.retryAfterSeconds) },
      },
    );
  }

  try {
    const stored = await saveScreenshot({
      user: auth.user,
      deviceId: auth.deviceId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      // Advisory only. The part's own `type` and `name` are deliberately
      // ignored — both are strings the client wrote, and neither decides
      // anything about what is stored or where.
      capturedAtRaw: form.get("capturedAt"),
      displayIdRaw: form.get("displayId"),
    });

    return Response.json({ ok: true, screenshot: stored }, { status: 201, headers: noStore });
  } catch (error) {
    /*
     * Nothing was stored, so the window this request claimed is handed back.
     * The policy is one *successful* screenshot per window: a 409 for a shift
     * that had just ended, or a 415 for a corrupt body, must not also cost the
     * workstation its next five minutes.
     */
    await releaseUploadSlot(auth.deviceId, slot);

    if (error instanceof ScreenshotError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }

    console.error("POST /api/monitor/screenshots failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not store that screenshot. Try again in a moment.",
      },
      { status: 500, headers: noStore },
    );
  }
}
