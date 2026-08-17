/**
 * The second lock on state-changing requests.
 *
 * ---------------------------------------------------------------------------
 * What was already here
 * ---------------------------------------------------------------------------
 * The session cookie is `SameSite=Lax` (lib/session.ts), which keeps it off
 * cross-site POSTs in every browser that honours the attribute. That is a real
 * defence and it is not being replaced. It is also the *only* one, and it lives
 * entirely on the client: a browser that gets the attribute wrong, a future
 * relaxation of the cookie for some unrelated reason, or one of the several
 * documented Lax edge cases, and there is nothing behind it. This module is the
 * thing behind it, and it runs on the server.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * For a request that changes something (POST, PUT, PATCH, DELETE) and carries
 * the session cookie:
 *
 *   1. `Sec-Fetch-Site` — sent by every current browser, set by the browser
 *      itself and unforgeable by page script. Anything other than `same-origin`
 *      is refused. `same-site` is refused too, deliberately: this box hosts
 *      about ten sites under the same parent `sslip.io` name, so "same site" is
 *      a neighbour, not us.
 *   2. `Origin` — must name this deployment. Browsers send it on every
 *      state-changing request, same-origin ones included.
 *   3. Neither header present: allowed. That combination is not a browser, and
 *      CSRF is a browser attack — it needs a victim whose credentials get
 *      attached automatically. curl, the repository's own test scripts and any
 *      server-to-server caller land here, and refusing them would break real
 *      workflows to defend against nothing. Whatever such a caller sends, it
 *      still has to present a valid session cookie, which is exactly the thing
 *      an attacker's page cannot read.
 *
 * The body is never touched, so a multipart upload costs nothing here and is
 * not consumed before its handler sees it.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not cover
 * ---------------------------------------------------------------------------
 * The bearer-token routes under `/api/monitor` and `/api/leads/ingest`. They
 * authenticate from an `Authorization` header the caller has to supply on
 * purpose, so no browser attaches it for them and there is no cross-site
 * request that could carry one. Applying this to them would only break the
 * desktop client, which sends no `Origin` and is not a browser.
 */

/** Methods that can change server state. Everything else is read-only. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isStateChangingMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/**
 * Extra origins that count as this deployment.
 *
 * Optional, and normally unset: the check below compares `Origin` against the
 * request's own `Host`, which nginx has already constrained to this vhost's
 * `server_name` before the request can reach us. This exists for the case where
 * that is not enough — a deployment reached under a name the proxy rewrites, or
 * a second public hostname — so that nothing here has to hardcode a hostname
 * and no environment needs a code change to be reachable.
 *
 * Comma-separated absolute origins: `https://leads.example.com,https://alt.example.com`.
 */
function configuredOrigins(): string[] {
  const raw = process.env.APP_ORIGIN;
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map(normaliseOrigin)
    .filter((value): value is string => value !== null);
}

/** `https://Host:443/path` → `host:443`. Scheme and path dropped; see below. */
function normaliseOrigin(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is this request coming from ourselves?
 *
 * Hosts are compared, not full origins. The scheme is dropped because it is not
 * ours to compare: TLS terminates at nginx and the request arrives over plain
 * http on loopback, so the app's own view of the scheme is `http` while the
 * browser's `Origin` says `https`. `X-Forwarded-Proto` carries the real one and
 * is checked nowhere here on purpose — a mismatch of scheme between two
 * requests to the same host is not a cross-site request, and http is redirected
 * to https at the edge anyway.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");

  // A browser told us where this came from. Nothing else is accepted.
  if (site !== null && site !== "same-origin") return false;

  if (origin !== null) {
    // `Origin: null` is what a sandboxed iframe, a `data:` document or some
    // redirect chains send. It is not this site.
    const originHost = origin === "null" ? null : normaliseOrigin(origin);
    if (originHost === null) return false;

    const host = request.headers.get("host")?.toLowerCase() ?? null;
    if (host !== null && originHost === host) return true;

    return configuredOrigins().includes(originHost);
  }

  // No `Origin`. Either the browser said `Sec-Fetch-Site: same-origin` (rule 1
  // let it through), or this is not a browser at all (rule 3).
  return true;
}

/**
 * The refusal body, shared so the proxy and the route guards answer a
 * cross-site request identically.
 *
 * It says "cross-site" rather than naming the header that gave it away: the
 * message is for a developer reading a console, and the detail goes to the
 * server log, where a page cannot see it.
 */
export const CROSS_SITE_BODY = {
  error: "cross_site_request",
  message: "This request did not come from the portal.",
} as const;

export function crossSiteJson(): Response {
  return Response.json(CROSS_SITE_BODY, {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * The whole check, for a caller that has a `Request` in hand.
 *
 * Returns the refusal to send, or null to continue — the same shape as the
 * guards in `lib/authz.ts`, so a handler can keep its `if (x instanceof
 * Response) return x` idiom.
 */
export function csrfRefusal(request: Request): Response | null {
  if (!isStateChangingMethod(request.method)) return null;
  if (isSameOriginRequest(request)) return null;

  console.warn(
    `[csrf] refused ${request.method} ${new URL(request.url).pathname} ` +
      `origin=${request.headers.get("origin") ?? "-"} ` +
      `sec-fetch-site=${request.headers.get("sec-fetch-site") ?? "-"}`,
  );
  return crossSiteJson();
}
