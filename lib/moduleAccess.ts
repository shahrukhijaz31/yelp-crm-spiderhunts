import { cache } from "react";

import { HOME_PATH, type Role, type SessionUser } from "./access";
import {
  ADMIN_MODULE_ACCESS,
  landingPathFor,
  moduleAccessOf,
  type ModuleAccess,
  type ModuleAccessColumns,
} from "./modules";
import { prisma } from "./prisma";

/**
 * Reading an account's module access out of Postgres.
 *
 * Split from `lib/modules.ts` for the reason that file gives: the policy is
 * imported by client components and must stay free of Prisma, while the read is
 * server-only. What is here is one query and nothing else — no decision is made
 * in this file that `moduleAccessOf` does not make.
 *
 * ---------------------------------------------------------------------------
 * Why this is a query and not a field on `SessionUser`
 * ---------------------------------------------------------------------------
 * It could have ridden along in the session lookup, and that was the first
 * design. It is a separate read because `SessionUser` is constructed in seven
 * places across modules that have nothing to do with permissions — the monitor
 * device auth, the performance reports, the time-tracking reads — and widening
 * that type would have meant editing all seven to satisfy a compiler rather
 * than to change any behaviour. A guard that needs the flags asks for them.
 *
 * The cost is one primary-key lookup on `users`, memoised per request by
 * React's `cache`, and skipped entirely for administrators (see below). A page
 * that renders the nav and then runs an API-side guard pays for one.
 *
 * ---------------------------------------------------------------------------
 * Freshness
 * ---------------------------------------------------------------------------
 * Read from Postgres on the request that needs it, never from the cookie and
 * never from anything the client sent. An administrator un-ticking Demo
 * Websites takes effect on that agent's very next request — there is no cached
 * grant to expire, and no need to end their session to make the change stick.
 */

/**
 * The modules this user may reach, right now.
 *
 * Administrators are answered without touching the database. That is not an
 * optimisation: it is the rule from `lib/modules.ts` — the flags on an
 * administrator's row are never consulted — expressed as the absence of a
 * query. There is no value in that row that could change this answer.
 */
export const moduleAccessFor = cache(
  async (user: SessionUser): Promise<ModuleAccess> => {
    if (user.role === "ADMIN") return { ...ADMIN_MODULE_ACCESS };

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { canAccessLeads: true, canAccessDemoWebsites: true },
    });

    // A session whose user vanished between `getSessionUser` and here has no
    // access to anything. `moduleAccessOf` on an all-false row rather than a
    // throw: the caller's next line is a refusal either way, and a 500 would
    // turn a deleted account into an outage.
    return moduleAccessOf(user.role, row ?? { canAccessLeads: false, canAccessDemoWebsites: false });
  },
);

/**
 * Set an agent's module access. ADMIN-only, enforced by the route that calls
 * this — there is no identity in this function and it makes no decision about
 * who may call it.
 *
 * Partial by design: the user list sends one checkbox at a time, so ticking
 * Demo Websites must not silently rewrite the Leads flag from a stale copy of
 * the row the browser was holding.
 */
export function moduleEditsFrom(payload: Record<string, unknown>): Partial<ModuleAccessColumns> {
  const edits: Partial<ModuleAccessColumns> = {};
  if (typeof payload.canAccessLeads === "boolean") {
    edits.canAccessLeads = payload.canAccessLeads;
  }
  if (typeof payload.canAccessDemoWebsites === "boolean") {
    edits.canAccessDemoWebsites = payload.canAccessDemoWebsites;
  }
  return edits;
}

/**
 * Where a sign-in should land, when the caller asked for nowhere in particular.
 *
 * `/` is the worklist, and an agent whose account has Demo Websites and not
 * Leads must not be sent there: the page redirects them onwards, but by then
 * the shell has already begun streaming, so Next can only finish the job with a
 * one-second meta refresh — a visible flash of a workspace they may not use.
 * Deciding it here, before any HTML exists, makes the sign-in land in the right
 * place first time.
 *
 * A *requested* destination is never overridden. Somebody who followed a link
 * to a specific page and was bounced through the login form is sent back to
 * that page, and refused there if they may not have it — silently redirecting
 * them somewhere else would hide the refusal behind a screen that looks like it
 * worked. Only the "no callbackUrl at all" case is answered here.
 *
 * `requested` has already been through `safeCallbackUrl`, so it is an internal
 * path; this function never widens it and never returns anything that is not
 * one of the portal's own routes.
 *
 * Uncached, unlike {@link moduleAccessFor}: the sign-in routes hold a user id
 * rather than a `SessionUser`, and this runs exactly once per sign-in.
 *
 * The role is read here rather than taken as an argument, because the two
 * callers know it to different degrees — the OTP route holds only the id its
 * verification returned — and a role passed in wrongly would be a redirect
 * decided from a guess.
 */
export async function landingRedirectFor(
  userId: string,
  requested: string,
): Promise<string> {
  if (requested !== HOME_PATH) return requested;

  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, canAccessLeads: true, canAccessDemoWebsites: true },
  });
  if (!row) return HOME_PATH;

  // Null — an account with neither module — falls back to the worklist, which
  // then shows the refusal screen. That is the honest answer for an account an
  // administrator has not finished setting up, and it is a screen that says so
  // rather than a redirect loop looking for somewhere to go.
  return landingPathFor(moduleAccessOf(row.role as Role, row)) ?? HOME_PATH;
}
