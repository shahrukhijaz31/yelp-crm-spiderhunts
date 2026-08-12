import { apiAdmin } from "@/lib/authz";
import { screenshotPage } from "@/lib/screenshotViewer";
import { resolveScreenshotQuery } from "@/lib/screenshotViewerRules";

/**
 * GET /api/screenshots — a page of captured screenshots. ADMIN only.
 *
 * The endpoint behind the Screenshots screen, and the one an agent must never
 * reach. Three things enforce that, and only the first two are load-bearing:
 *
 *   1. `apiAdmin()` — resolves the caller from the session row in Postgres,
 *      re-reads `role` from the database rather than from anything the browser
 *      sent, and answers 401 when signed out or 403 when an agent, before a
 *      single parameter is read. An agent with a valid session and curl gets
 *      the refusal.
 *   2. The path sits under `/api/screenshots`, which `lib/access.ts` lists as
 *      an admin prefix — so the policy naming this endpoint admin-only is
 *      written in the same file as the policy for the screen it serves, and
 *      neither can be changed without the other being read.
 *   3. The navigation does not draw the link for an agent. Tidiness, not
 *      security — removing it would change nothing about who can read this.
 *
 * Named `/api/screenshots` rather than `/api/admin/screenshots` to match the
 * two admin-only APIs already here, `/api/users` and `/api/reports`: this
 * application says who may call an endpoint in `lib/access.ts` and in the
 * handler's own guard, not in the URL. No collision with the upload route,
 * which is `/api/monitor/screenshots` and authenticates a device rather than a
 * browser — the two are separate paths with separate credentials and neither
 * is affected by the other.
 *
 * **Every filter is a filter.** `agent`, `session`, `date` and the time pair
 * narrow a read that has already been authorized; none is ever consulted to
 * decide whether the caller may see anything, which is why they are safe as
 * arbitrary strings and are clamped rather than rejected
 * (`resolveScreenshotQuery`). A monitoring screen should not 400 an
 * administrator over a stale bookmark.
 *
 * **No path ever leaves here.** The response carries screenshot *ids*; the
 * storage key is not selected by the query that builds it, so there is no
 * filesystem detail in the payload to leak and none in the browser's memory.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  const query = resolveScreenshotQuery(new URL(request.url).searchParams);

  try {
    const payload = await screenshotPage(query);
    return Response.json(payload, {
      // The same `no-store` the rest of the API sends. Screenshots of an
      // employee's desktop must not sit in any cache, shared or otherwise.
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("GET /api/screenshots failed:", error);
    return Response.json(
      {
        error: "server_error",
        message: "Could not load screenshots. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
