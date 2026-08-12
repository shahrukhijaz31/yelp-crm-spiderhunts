/**
 * The access policy, in one file.
 *
 * Everything that needs to know "who may see this path" reads it from here:
 * `proxy.ts` at the edge of every request, the page guards inside the portal,
 * and the nav bar when deciding which tabs to draw. Three copies of the same
 * list would drift, and the copy that drifts is always the one enforcing.
 *
 * No imports on purpose. This module is pulled into the proxy, so it must stay
 * free of Prisma, `next/headers` and anything else with a runtime of its own.
 */

export type Role = "ADMIN" | "AGENT";

/**
 * The session cookie's name.
 *
 * `__Host-` in production is not decoration: the prefix makes the browser
 * refuse the cookie unless it is Secure, `Path=/` and has no `Domain`, which
 * means a sibling host on this box — several other sites share the same
 * server and the same parent `sslip.io` domain — cannot set a cookie that
 * this app would then read. Development is plain http, where the prefix would
 * make the cookie unsettable, so the name is plain there.
 */
export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

/** The shape of the signed-in user as it travels to client components. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  username: string;
  role: Role;
}

/** Where a signed-in user lands when no specific destination was requested. */
export const HOME_PATH = "/";

export const LOGIN_PATH = "/login";

/**
 * Reachable without a session.
 *
 * `/api/health` is polled by deploy.sh before nginx switches traffic, and
 * `/api/leads/ingest` is called by the scraper on another box with its own
 * bearer token (`lib/ingestAuth.ts`) — neither can carry a session cookie, and
 * both were already exempted at the nginx layer for the same reason.
 *
 * The two reset endpoints are public for the obvious reason: someone redeeming
 * a one-time code has no password and therefore cannot have a session. They are
 * not unauthenticated in any meaningful sense — the code *is* the credential,
 * it is checked server-side against a hash on every call, and neither endpoint
 * ever issues a session (see `lib/passwordReset.ts`).
 *
 * The three OTP endpoints are public for the same reason and with the same
 * caveat: somebody halfway through signing in has, by design, no session yet.
 * They are gated on the pending challenge cookie instead, which names nobody
 * and is resolved server-side (`lib/loginOtp.ts`) — `verify` is the one that
 * mints the session, and it only does so for a code that matches a live,
 * unspent, unexhausted row.
 */
const PUBLIC_PATHS = new Set<string>([
  LOGIN_PATH,
  "/api/auth/login",
  "/api/auth/otp/verify",
  "/api/auth/otp/resend",
  "/api/auth/otp/cancel",
  "/api/auth/reset/verify",
  "/api/auth/reset/complete",
  "/api/health",
  "/api/leads/ingest",
  /*
   * The SpiderHunts Monitor desktop application. "Public" here means what it
   * means for `/api/leads/ingest`: exempt from the *cookie* check this proxy
   * performs, because these callers are not browsers and have no session cookie
   * to present. They are not unauthenticated.
   *
   * Each auth step carries its own credential — a password, then the emailed
   * code against a challenge token, then a refresh token — and
   * `/api/monitor/session` requires `Authorization: Bearer` and is gated by
   * `monitorUser()` inside the handler, which resolves the token against
   * `monitor_devices` and re-reads role and `isActive` from Postgres on every
   * call. `/logout` needs no credential by design: revoking a token is safe for
   * whoever holds it, and refusing an unauthenticated logout would only strand
   * a client whose access token had already expired.
   *
   * Listed one by one rather than as a prefix, deliberately — each addition is
   * a decision someone made, not something inherited from a wildcard.
   */
  "/api/monitor/auth/login",
  "/api/monitor/auth/verify",
  "/api/monitor/auth/resend",
  "/api/monitor/auth/refresh",
  "/api/monitor/auth/logout",
  "/api/monitor/session",
  /*
   * The screenshot upload. Bearer-authenticated by `monitorDevice()` inside the
   * handler, which resolves the token against `monitor_devices` and re-reads
   * role and `isActive` from Postgres — so "public" here means the same thing
   * it means above: exempt from the cookie check, not exempt from
   * authentication. It is also the only write endpoint on this list.
   */
  "/api/monitor/screenshots",
  /*
   * The activity report. Identical in kind to the screenshot upload above and
   * exempt for the identical reason: `monitorDevice()` inside the handler
   * resolves the bearer token against `monitor_devices` and re-reads role and
   * `isActive` from Postgres on every call, so "public" means exempt from the
   * cookie check and nothing else.
   *
   * It is the second write endpoint on this list. What it can write is one row
   * in `activity_intervals`, attributed to the device's own user and to that
   * user's currently-open shift — both server-derived. It cannot create,
   * extend or close a work session; see `lib/activity.ts`.
   */
  "/api/monitor/activity",
  /*
   * The screenshot retention sweep, called by the box's own cron
   * (`deploy/leadportal-screenshot-retention`). Same shape as the ingest route:
   * not a browser, no session cookie, its own bearer token checked inside the
   * handler — and a 503 rather than an open door when that token is unset.
   *
   * It takes no parameters, so there is nothing a caller could point it at: the
   * only deletion it can perform is the server's own configured retention
   * window against the server's own `created_at`.
   */
  "/api/maintenance/screenshot-retention",
]);

/**
 * ADMIN-only prefixes, pages and APIs alike.
 *
 * `/import` is the "Upload CSV" workspace and `/export` is "Export Data" —
 * the URLs predate the nav labels. Both are listed because both are the whole
 * lead database leaving or entering the system in one action.
 */
/*
 * Deliberately not here: `/api/meetings/:id/recording*`. Call recordings are
 * not gated by path — both roles may upload one, and whether a given recording
 * may be played or deleted depends on who uploaded it, which is a row in the
 * database rather than a prefix. That decision lives in `lib/recordings.ts`;
 * listing the path here would either lock agents out of their own job or say
 * nothing useful.
 */
/*
 * Deliberately not here either: `/my-performance` and `/api/performance/me`.
 * Those are a person's own figures, which every role is entitled to and no role
 * may see for anyone else — a rule about *whose* row rather than about a path.
 * It is kept where it can actually be enforced: the endpoint takes no user id
 * at all and queries the session's own (see `app/api/performance/me/route.ts`).
 *
 * The team-wide view *is* a path rule, and `/reports` already covers the page
 * side of it — `/reports/team` is prefixed by it, so `canAccess` hides the nav
 * item and the page's own `requireRole` refuses an agent who types the URL.
 * `/api/reports` is added so the endpoint behind that screen is described by
 * the same policy as the screen; the enforcement is `apiAdmin()` inside the
 * handler, which is what an agent with curl actually meets.
 */
/*
 * `/screenshots` and `/api/screenshots` are the administrator's screenshot
 * viewer — the screen and the endpoints behind it. Unlike call recordings,
 * which are gated by *who uploaded them* and therefore cannot be a path rule,
 * this genuinely is one: no agent may see any screenshot, including their own.
 * A monitoring feature whose subject can read it back is a different feature.
 *
 * `/api/monitor/screenshots` is not affected and is not related. That is the
 * desktop client's upload route, bearer-authenticated per device, and it is
 * listed among the public paths above for the reason given there — prefix
 * matching here is on the whole path, so the two never meet.
 */
/*
 * `/api/time-adjustments` is the manual time-correction endpoint, and it is the
 * only path on this list that *writes* to `work_sessions`. It is named
 * separately rather than nested under `/api/reports` because a correction is
 * not a report: reading somebody's hours and rewriting them are different
 * powers, and the policy should not have to be inferred from a URL prefix that
 * was chosen for a screen.
 *
 * Deliberately not here: `/time-tracking` and `/api/time-tracking/me`, which
 * are an agent's own tracking record — the same rule, and the same reasoning,
 * as `/my-performance` above. The endpoint takes no user id and queries the
 * session's own; the admin view of the same data is `/reports/time`, a
 * different screen behind a different endpoint, admin-only at both ends.
 */
const ADMIN_PREFIXES = [
  "/export",
  "/import",
  "/reports",
  "/screenshots",
  "/settings",
  "/users",
  "/api/leads/upload",
  "/api/reports",
  "/api/screenshots",
  "/api/time-adjustments",
  "/api/users",
] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** Prefix match on a segment boundary, so `/users-export` is not `/users`. */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function canAccess(role: Role, pathname: string): boolean {
  return role === "ADMIN" || !isAdminPath(pathname);
}

/**
 * Turn an untrusted `?callbackUrl=` into something safe to `Location:`.
 *
 * The whole point of the parameter is that an attacker can put anything in it
 * and mail the link to someone. Rules:
 *
 *   - must be a path on this site — `//evil.com` and `https://evil.com` are
 *     both absolute URLs to a browser, and `/\evil.com` is treated as `//` by
 *     some of them, so anything that is not a single leading slash is refused;
 *   - no backslashes at all, which closes the `/\/evil.com` variants;
 *   - never `/login`, or a successful sign-in bounces straight back to the
 *     form it just came from.
 *
 * Anything rejected falls back to the workspace rather than erroring: a
 * mangled link should still sign you in.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (!raw) return HOME_PATH;
  if (!raw.startsWith("/")) return HOME_PATH;
  if (raw.startsWith("//") || raw.includes("\\")) return HOME_PATH;
  // Control characters can smuggle a second header past a careless proxy.
  if (hasControlCharacter(raw)) return HOME_PATH;

  const [pathname] = raw.split(/[?#]/, 1);
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return HOME_PATH;

  return raw;
}

/** CR, LF, NUL and friends — anything below 0x20, plus DEL. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
