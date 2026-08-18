import { apiUser } from "@/lib/authz";
import { myScreenshotPage } from "@/lib/myScreenshots";
import { resolveMyScreenshotQuery } from "@/lib/myScreenshotsRules";

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
 * The only id that reaches Postgres as a *subject* is `auth.id`, read from the
 * session row on this request. This route accepts no `userId` and no `agentId`
 * in any form, and no body at all. Adding `?agent=` or `?userId=` to the URL
 * changes nothing, because nothing reads them.
 *
 * What it does read is filters — a date preset and day, a time-of-day range, a
 * work session, a page and a page size — and every one of them is ANDed with
 * the subject rather than consulted about it (`lib/myScreenshots.ts`). A filter
 * can only ever select fewer of the caller's own rows. `?session=` is the one
 * that is an id somebody could tamper with, and it is worth being explicit: a
 * shift id belonging to another agent asks for rows that are both theirs and
 * yours, so it returns an empty page rather than their gallery. It narrows to
 * nothing; it cannot widen to anybody.
 *
 * That is also why nothing here 400s. Every parameter is clamped to something
 * sensible by `resolveMyScreenshotQuery` — an unknown preset becomes "all
 * dates", a page size that is not on the menu becomes the default, a malformed
 * id becomes no filter — because none of them is deciding anything that a
 * wrong answer would make unsafe, and a screen that errors over a stale
 * bookmark is worse than one that shows you your own list.
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
      // one — `myScreenshotPage` has no other way to be told whose list this is,
      // and the query object it takes has no field that could carry a user.
      auth.id,
      resolveMyScreenshotQuery(params),
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
