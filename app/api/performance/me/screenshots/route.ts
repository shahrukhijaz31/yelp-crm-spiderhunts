import { apiUser } from "@/lib/authz";
import { myScreenshotPage } from "@/lib/myScreenshots";
import {
  decodeMyScreenshotCursor,
  readMyScreenshotLimit,
} from "@/lib/myScreenshotsRules";

/**
 * GET /api/performance/me/screenshots — the caller's own captures, and nobody
 * else's.
 *
 * ---------------------------------------------------------------------------
 * Why it lives here rather than beside the admin viewer
 * ---------------------------------------------------------------------------
 * `/api/screenshots` is admin-only and stays admin-only: it is named in
 * `ADMIN_PREFIXES`, it is guarded by `apiAdmin()`, and it takes an `?agent=`
 * filter because an administrator is entitled to use one. Adding a role branch
 * inside it would mean the agent-reachable code path ran through a query that
 * can name a person — the branch is the bug.
 *
 * So this is a second endpoint under `/api/performance/me`, which is where this
 * application already keeps "your own figures and nobody's else's" (see
 * `app/api/performance/me/route.ts`, whose reasoning this follows exactly). The
 * prefix is not in `ADMIN_PREFIXES` and must not be: administrators have their
 * own day too, and this returns *theirs* when they call it. It is not in
 * `PUBLIC_PATHS` either, so `proxy.ts` turns away a request with no session
 * cookie before the handler is reached, and `apiUser()` below is the check that
 * actually decides.
 *
 * ---------------------------------------------------------------------------
 * The security property, which is a shape rather than a check
 * ---------------------------------------------------------------------------
 * The only id that reaches Postgres is `auth.id`, read from the session row on
 * this request. This route accepts no `userId`, no `agentId`, no
 * `workSessionId` and no body — the two parameters it does read are `cursor`
 * and `limit`, one a position in a list that has already been scoped and the
 * other a page size that is clamped. There is nothing here to tamper with, so
 * there is nothing to validate and nothing to get wrong. Adding `?agent=` to
 * the URL changes nothing, because nothing reads it.
 *
 * ---------------------------------------------------------------------------
 * Read-only
 * ---------------------------------------------------------------------------
 * This file exports `GET` and only `GET`. A POST, PATCH, PUT or DELETE to this
 * path is a 405 from the framework before any code of ours runs, and there is
 * no agent-reachable route anywhere that deletes, uploads or modifies a
 * screenshot: deletion is `/api/admin/screenshots*` behind `apiAdmin()`, upload
 * is `/api/monitor/screenshots` behind a device token, and retention is
 * `/api/maintenance/screenshot-retention` behind the cron's bearer token.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;

  try {
    const payload = await myScreenshotPage(
      // The subject, from the session. Not a parameter, and not overridable by
      // one — `myScreenshotPage` has no other way to be told whose list this is.
      auth.id,
      decodeMyScreenshotCursor(params.get("cursor")),
      readMyScreenshotLimit(params.get("limit")),
    );

    return Response.json(payload, {
      // The same `private, no-store` the admin viewer sends, for the same
      // reason: a list describing when somebody's desktop was photographed must
      // not sit in a shared cache or survive a sign-out on disk.
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("GET /api/performance/me/screenshots failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not load your screenshots. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
