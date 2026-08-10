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
 */
const PUBLIC_PATHS = new Set<string>([
  LOGIN_PATH,
  "/api/auth/login",
  "/api/auth/reset/verify",
  "/api/auth/reset/complete",
  "/api/health",
  "/api/leads/ingest",
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
const ADMIN_PREFIXES = [
  "/export",
  "/import",
  "/reports",
  "/settings",
  "/users",
  "/api/leads/upload",
  "/api/reports",
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
