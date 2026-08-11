import { timingSafeEqual } from "node:crypto";

import { runScreenshotRetention } from "@/lib/screenshotRetention";

/**
 * POST /api/maintenance/screenshot-retention — delete screenshots past their
 * retention window.
 *
 * ---------------------------------------------------------------------------
 * Why a route rather than a timer inside the app
 * ---------------------------------------------------------------------------
 * Every other piece of housekeeping in this application is *opportunistic* —
 * `pruneExpiredSessions`, `pruneExpiredDevices`, `pruneExpiredLoginOtps` are all
 * fired off from a login route with the comment "this app has no cron". That
 * pattern is right for those: they delete a handful of expired rows, they cost
 * one indexed `DELETE`, and if a quiet day means they do not run, nothing is
 * harmed.
 *
 * Retention is not that. It touches the filesystem, it can walk thousands of
 * rows, and it must run on a *schedule* rather than on whoever happens to log
 * in — a team on holiday should not stop the images ageing out. Hanging it off
 * a request would also mean an agent's upload occasionally paying for a sweep,
 * which the requirement rules out directly.
 *
 * A `setInterval` in the server process is the other obvious answer, and it is
 * wrong here for a specific reason: `deploy/ecosystem.config.cjs` runs the app
 * in PM2 cluster mode with two workers, and blue/green means two slots exist
 * during a deploy. A module-level timer would run in every one of them.
 *
 * So the box's cron calls this, exactly once, at a time of our choosing —
 * reusing the crontab `deploy/provision.sh` already installs and manages for the
 * nightly backup. `deploy/leadportal-screenshot-retention` is the caller.
 *
 * ---------------------------------------------------------------------------
 * Who may call it
 * ---------------------------------------------------------------------------
 * Whoever holds `SCREENSHOT_RETENTION_TOKEN`, and nobody else. The same
 * construction `lib/ingestAuth.ts` uses for the scraper: a bearer token
 * compared in constant time, and a hard 503 when the variable is unset so the
 * endpoint cannot fall open on a deploy that forgot it.
 *
 * **No agent, admin or browser session can reach this.** It takes no
 * parameters at all — no id, no user, no date, no path — so there is nothing to
 * point it at. The only thing it can do is apply the server's own configured
 * retention window to the server's own `created_at` column, which is precisely
 * the requirement that an agent must never be able to trigger arbitrary
 * deletion.
 */

const noStore = { "Cache-Control": "no-store" } as const;

/** Constant-time compare that tolerates unequal lengths. As `lib/ingestAuth.ts`. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export async function POST(request: Request): Promise<Response> {
  // Read at call time, not module scope: the variable does not exist during
  // `next build`, and rotating it should need a restart and nothing more.
  const expected = process.env.SCREENSHOT_RETENTION_TOKEN?.trim() ?? "";
  if (!expected) {
    return Response.json(
      {
        error: "retention_not_configured",
        message: "SCREENSHOT_RETENTION_TOKEN is not set, so this endpoint is disabled.",
      },
      { status: 503, headers: noStore },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  const presented = rest.join(" ").trim();

  if (scheme.toLowerCase() !== "bearer" || !presented || !secretsMatch(presented, expected)) {
    return Response.json(
      { error: "unauthorized", message: "Expected `Authorization: Bearer <token>`." },
      { status: 401, headers: noStore },
    );
  }

  try {
    const result = await runScreenshotRetention();
    // Counts only. Nothing that names a person, a device or a file — the cron
    // log this lands in is not a record of who was photographed.
    return Response.json({ ok: true, ...result }, { headers: noStore });
  } catch (error) {
    console.error("[screenshot-retention] sweep failed:", error);
    return Response.json(
      { error: "server_error", message: "The retention sweep failed. See the server log." },
      { status: 500, headers: noStore },
    );
  }
}
