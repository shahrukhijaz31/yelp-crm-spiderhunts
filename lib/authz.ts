import { redirect } from "next/navigation";

import { LOGIN_PATH, type Role, type SessionUser } from "./access";
import { csrfRefusal } from "./csrf";
import { moduleAccessFor } from "./moduleAccess";
import { hasModule, type ModuleAccess, type PortalModule } from "./modules";
import { getSessionUser } from "./session";

/**
 * Authorization, in one place.
 *
 * Two families, because a page and an API endpoint fail differently:
 *
 *   requireUser / requireAdmin        pages — redirect or render Access Denied
 *   apiUser / apiAdmin                routes — 401 / 403 JSON, never a redirect
 *   requireModule / apiModule         either — the Demo Websites module gate
 *
 * Both resolve the caller through `getSessionUser`, which reads the session
 * row from Postgres. There is no path here that takes the browser's word for
 * anything: no header, no cookie field, no request body contributes to the
 * decision. That is the whole design — the client cannot describe itself.
 *
 * Route protection is layered, and each layer is load-bearing:
 *
 *   proxy.ts   turns away anyone without a session cookie before a page is
 *              ever rendered, and adds `Cache-Control: no-store`. Cheap, and
 *              it cannot tell a forged cookie from a real one.
 *   these      the authoritative check, run inside every protected page and
 *              route handler. Removing the proxy would change nothing about
 *              who can read what.
 *   the nav    hides tabs a role cannot use. Tidiness, not security.
 *
 * ---------------------------------------------------------------------------
 * Cross-site requests
 * ---------------------------------------------------------------------------
 * `apiUser`, `apiRole` and `apiAdmin` take the `Request` and, when the method
 * changes something, refuse it unless it came from this origin (`lib/csrf.ts`).
 * That check belongs here rather than in each handler for the same reason the
 * role check does: a guard everybody already calls cannot be the one somebody
 * forgets. `proxy.ts` performs the identical check first, so the two are belt
 * and braces over one shared rule and neither is load-bearing alone.
 *
 * The argument is optional so that a read-only handler that never had a
 * `Request` in scope does not have to grow one. Passing it costs nothing on a
 * GET — the check returns immediately for safe methods.
 */

/**
 * A page that requires a signed-in user.
 *
 * `callbackUrl` is threaded through so the user lands where they were going.
 * It is re-sanitised on the way back out (`safeCallbackUrl`) — this side only
 * ever produces an internal path, but the round trip goes through the address
 * bar, where anything can happen to it.
 */
export async function requireUser(callbackUrl?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(
      callbackUrl && callbackUrl !== "/"
        ? `${LOGIN_PATH}?callbackUrl=${encodeURIComponent(callbackUrl)}`
        : LOGIN_PATH,
    );
  }
  return user;
}

/**
 * A page that requires a specific role.
 *
 * Returns `{ user, allowed }` rather than redirecting on a role failure: an
 * authenticated agent who reaches an admin URL is not lost, they are refused,
 * and bouncing them to the login form they already satisfied is both confusing
 * and a good way to make someone think their session broke. The caller renders
 * `<AccessDenied />` instead.
 */
export async function requireRole(
  allowedRoles: Role | Role[],
  callbackUrl?: string,
): Promise<{ user: SessionUser; allowed: boolean }> {
  const user = await requireUser(callbackUrl);
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return { user, allowed: roles.includes(user.role) };
}

/** JSON 401. Shape matches the error envelope the rest of the API already uses. */
export function unauthorizedJson(): Response {
  return Response.json(
    {
      error: "unauthorized",
      message: "Sign in to use this endpoint.",
    },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * JSON 403.
 *
 * Deliberately says nothing about what the endpoint does or what role would be
 * required — "administrators only" is already more than an agent probing the
 * API needs to learn.
 */
export function forbiddenJson(): Response {
  return Response.json(
    {
      error: "forbidden",
      message: "You do not have permission to perform this action.",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Guard for a route handler that any signed-in user may call.
 *
 * Returns either the user or the Response to send back, so every handler opens
 * with the same three lines and cannot accidentally continue after a failure:
 *
 *   const auth = await apiUser(request);
 *   if (auth instanceof Response) return auth;
 *   // auth is the SessionUser from here on
 *
 * Pass the request on any handler that changes something; see the cross-site
 * note at the top of this file.
 */
export async function apiUser(request?: Request): Promise<SessionUser | Response> {
  const user = await getSessionUser();
  if (!user) return unauthorizedJson();

  // After the session, not before: a signed-out caller should be told they are
  // signed out, and an unauthenticated cross-site POST has nothing to steal.
  const crossSite = request ? csrfRefusal(request) : null;
  if (crossSite) return crossSite;

  return user;
}

/** Guard for an ADMIN-only route handler. 401 when signed out, 403 when an agent. */
export async function apiRole(
  allowedRoles: Role | Role[],
  request?: Request,
): Promise<SessionUser | Response> {
  const user = await getSessionUser();
  if (!user) return unauthorizedJson();

  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!roles.includes(user.role)) return forbiddenJson();

  const crossSite = request ? csrfRefusal(request) : null;
  if (crossSite) return crossSite;

  return user;
}

export const apiAdmin = (request?: Request): Promise<SessionUser | Response> =>
  apiRole("ADMIN", request);

/**
 * A page that requires one of the portal's modules.
 *
 * The module twin of {@link requireRole}, and it returns the same
 * `{ user, allowed }` shape for the same reason: an agent who reaches
 * `/demo-websites` without the Demo Websites module is refused, not lost, so
 * the caller renders `<AccessDenied />` rather than bouncing them to a login
 * form they already satisfied.
 *
 * `access` comes back too, because a page that has just paid for the lookup
 * usually needs it again — to decide which nav items the shell draws, or
 * whether to offer the other module as somewhere to go instead.
 *
 * Administrators are allowed by `moduleAccessFor` without a query. Nothing
 * here reads a module from the request: the module is named by the *caller*,
 * in code, and the only thing resolved from the wire is who is asking.
 */
export async function requireModule(
  module: PortalModule,
  callbackUrl?: string,
): Promise<{ user: SessionUser; access: ModuleAccess; allowed: boolean }> {
  const user = await requireUser(callbackUrl);
  const access = await moduleAccessFor(user);
  return { user, access, allowed: hasModule(access, module) };
}

/**
 * Guard for a route handler behind one of the portal's modules.
 *
 * Same contract as {@link apiUser} — the user, or the Response to return — so
 * a handler still opens with two lines it cannot accidentally continue past:
 *
 *   const auth = await apiModule("demoWebsites", request);
 *   if (auth instanceof Response) return auth;
 *
 * 401 when signed out, 403 when the module is not granted. The 403 is the same
 * opaque one every other refusal here sends: an agent probing the API learns
 * that they may not, and not what would make them able to.
 *
 * **This is the authoritative check, and it is per endpoint.** The nav not
 * drawing a link and `lib/access.ts` not listing the path are tidiness and
 * documentation respectively; this is what an agent with curl actually meets,
 * on every request, resolved against the `users` row in Postgres. Every
 * endpoint calls it for itself — a module gate applied once at a parent and
 * inherited would be a gate that a new sibling route silently escapes.
 */
export async function apiModule(
  module: PortalModule,
  request?: Request,
): Promise<SessionUser | Response> {
  const user = await getSessionUser();
  if (!user) return unauthorizedJson();

  const access = await moduleAccessFor(user);
  if (!hasModule(access, module)) return forbiddenJson();

  const crossSite = request ? csrfRefusal(request) : null;
  if (crossSite) return crossSite;

  return user;
}
