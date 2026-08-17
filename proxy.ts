import { NextResponse, type NextRequest } from "next/server";

import { isPublicPath, LOGIN_PATH, SESSION_COOKIE } from "@/lib/access";
import { CROSS_SITE_BODY, isSameOriginRequest, isStateChangingMethod } from "@/lib/csrf";

/**
 * The first gate. (Next 16 renamed Middleware to Proxy; same thing.)
 *
 * What it does: turns away requests that carry no session cookie at all,
 * before a protected page is rendered or a route handler is entered, and
 * stamps `Cache-Control: no-store` on everything it lets through.
 *
 * It also refuses a state-changing request that carries the session cookie but
 * did not come from this origin — the server-side half of the CSRF defence that
 * `SameSite=Lax` was previously doing alone. The rule itself lives in
 * `lib/csrf.ts` and is applied again by `lib/authz.ts`; here it is applied to
 * *everything* the matcher covers, so a route added tomorrow inherits it
 * whether or not its author remembers the guard. It reads three headers and
 * never the body, so an upload is not buffered by it.
 *
 * What it deliberately does NOT do: decide anything about *roles*, or trust
 * the cookie it sees. The cookie is an opaque token; knowing whether it maps
 * to a live session — and to whom — means a database query, and the Next.js
 * guidance is explicit that the proxy is for optimistic checks rather than
 * authorization. So this layer answers one cheap question ("is there any
 * plausible session here?") and the authoritative answer is given inside every
 * page and route by `lib/authz.ts`, against Postgres.
 *
 * That split is what makes the security property easy to state: deleting this
 * file would change no one's access. It would only mean an unauthenticated
 * visitor gets redirected a few milliseconds later, by the page instead of by
 * the proxy.
 *
 * The one thing it must not do is over-reach. The matcher below excludes
 * `_next/*` and the static assets; blocking those would break the login page's
 * own CSS and fonts, and they carry no data.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // Signed in and asking for the login form: send them to the workspace. The
  // page itself repeats this check against the database, because a cookie
  // being *present* is not the same as it being valid.
  if (pathname === LOGIN_PATH && hasSessionCookie) {
    return noStore(NextResponse.redirect(new URL("/", request.url)));
  }

  if (isPublicPath(pathname)) return noStore(NextResponse.next());

  /*
   * Cross-site state change, with this browser's session cookie attached.
   *
   * Checked after the public-path list on purpose: everything on that list is
   * either unauthenticated or bearer-authenticated (the Monitor, the scraper),
   * and none of it relies on the cookie a browser attaches by itself. Applying
   * an Origin rule to the desktop client would refuse it for sending no Origin
   * at all, which is what a non-browser does.
   *
   * Checked before the sign-in redirect for the opposite reason: this is not a
   * statement about who the caller is, and a request that fails it should not
   * be told to go and authenticate.
   */
  if (hasSessionCookie && isStateChangingMethod(request.method) && !isSameOriginRequest(request)) {
    console.warn(
      `[csrf] proxy refused ${request.method} ${pathname} ` +
        `origin=${request.headers.get("origin") ?? "-"} ` +
        `sec-fetch-site=${request.headers.get("sec-fetch-site") ?? "-"}`,
    );
    return noStore(NextResponse.json(CROSS_SITE_BODY, { status: 403 }));
  }

  if (!hasSessionCookie) {
    // API callers get JSON. Redirecting an XHR to an HTML login page produces
    // a 200 full of markup where the client expected data, and the client then
    // reports a parse error instead of "you are signed out".
    if (pathname.startsWith("/api/")) {
      return noStore(
        NextResponse.json(
          { error: "unauthorized", message: "Sign in to use this endpoint." },
          { status: 401 },
        ),
      );
    }

    const login = new URL(LOGIN_PATH, request.url);
    // Remember where they were headed. The value is re-sanitised on the way
    // back out — see `safeCallbackUrl` — because it passes through the address
    // bar in between, where anything can be substituted for it.
    if (pathname !== "/") login.searchParams.set("callbackUrl", `${pathname}${search}`);
    return noStore(NextResponse.redirect(login));
  }

  return noStore(NextResponse.next());
}

/**
 * Keep authenticated responses out of shared and browser caches.
 *
 * Without this a proxy — or the browser's own back/forward cache — can serve
 * the previous user's worklist to whoever is at the keyboard after a logout.
 */
function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return response;
}

export const config = {
  /**
   * Everything except Next's own build output and the static files served from
   * `public/`. `logo.ico` is on that list because the login page renders it
   * before anyone has signed in.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|csv)$).*)"],
};
