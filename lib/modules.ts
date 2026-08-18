import type { Role } from "./access";

/**
 * The portal's major modules, and who may reach them.
 *
 * This portal now has two workspaces rather than one: **Leads**, the call list
 * and everything hanging off it, and **Demo Websites**, the sites an agent
 * presents to a client. An administrator decides, per account, which of the two
 * an agent is shown and served.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it deliberately is not
 * ---------------------------------------------------------------------------
 * It is *module* access: "may this person reach the Demo Websites workspace at
 * all". It is **not** record ownership — nothing anywhere assigns a particular
 * demo website to a particular agent, and there is no column that could. That
 * was a deliberate choice rather than an omission: per-record assignment is a
 * different feature with a different table, and inventing half of it here
 * would leave a permission model that is neither.
 *
 * It is also not a role. `UserRole` stays exactly two values, ADMIN and AGENT,
 * and no third one was added: an agent with Demo Websites is an agent, and the
 * thing that changed is which screens they are served.
 *
 * ---------------------------------------------------------------------------
 * No imports with a runtime
 * ---------------------------------------------------------------------------
 * Same rule as `lib/access.ts`, and for the same reason: this file is read by
 * the sidebar in the browser and by every guard on the server, so it must stay
 * free of Prisma and `next/headers`. The database read that fills in an agent's
 * flags lives next door in `lib/moduleAccess.ts`; the *policy* — what the flags
 * mean, and that an administrator is not subject to them — is here, once.
 */

/** The two modules, as keys. Nothing outside this list is a module. */
export const PORTAL_MODULES = ["leads", "demoWebsites"] as const;

export type PortalModule = (typeof PORTAL_MODULES)[number];

/** What an administrator ticks in the user list. Copy lives here, not in the DB. */
export const MODULE_LABELS: Record<PortalModule, string> = {
  leads: "Leads",
  demoWebsites: "Demo Websites",
};

/**
 * Which modules one account may reach.
 *
 * A record rather than a `Set` so it survives `JSON.stringify` on its way to a
 * client component, and so an unknown key is a type error rather than a silent
 * `false`.
 */
export type ModuleAccess = Record<PortalModule, boolean>;

/**
 * Administrators, always both.
 *
 * Not "the flags on an administrator's row happen to be true" — the columns are
 * never read for an administrator at all (see `moduleAccessFor`). That is what
 * makes an administrator impossible to lock out of a module by a stray UPDATE,
 * a bad migration or a mis-clicked checkbox, and it is why the user list draws
 * an administrator's boxes ticked and disabled rather than editable.
 */
export const ADMIN_MODULE_ACCESS: ModuleAccess = Object.freeze({
  leads: true,
  demoWebsites: true,
});

/**
 * What a brand-new agent gets, and what every account that predates Demo
 * Websites kept: the worklist they were already working, and nothing new.
 *
 * The same two values as the column defaults in `schema.prisma`. They are
 * written twice on purpose — the database owns what happens to a row nobody
 * mentions, this owns what the application means by "an agent with no explicit
 * grant" — and `scripts/test-demo-websites.ts` checks the two still agree.
 */
export const DEFAULT_MODULE_ACCESS: ModuleAccess = Object.freeze({
  leads: true,
  demoWebsites: false,
});

/** Nobody at all. The answer for a caller with no session. */
export const NO_MODULE_ACCESS: ModuleAccess = Object.freeze({
  leads: false,
  demoWebsites: false,
});

/** The two `users` columns, as they are named on the row. */
export interface ModuleAccessColumns {
  canAccessLeads: boolean;
  canAccessDemoWebsites: boolean;
}

/**
 * A role and a row, as an answer.
 *
 * The one place the "administrators are not subject to the flags" rule is
 * written down. Everything that needs to know whether somebody may reach a
 * module goes through here or through {@link hasModule}, so the rule cannot be
 * applied in one place and forgotten in another.
 */
export function moduleAccessOf(role: Role, columns: ModuleAccessColumns): ModuleAccess {
  if (role === "ADMIN") return { ...ADMIN_MODULE_ACCESS };
  return {
    leads: columns.canAccessLeads,
    demoWebsites: columns.canAccessDemoWebsites,
  };
}

/** The columns for a given access record — the inverse of {@link moduleAccessOf}. */
export function moduleColumnsOf(access: ModuleAccess): ModuleAccessColumns {
  return {
    canAccessLeads: access.leads,
    canAccessDemoWebsites: access.demoWebsites,
  };
}

/** Whether an account may reach one module. */
export function hasModule(access: ModuleAccess, module: PortalModule): boolean {
  return access[module] === true;
}

/** A module key from an untrusted string, or null. Used when parsing a body. */
export function readModule(value: unknown): PortalModule | null {
  return typeof value === "string" && (PORTAL_MODULES as readonly string[]).includes(value)
    ? (value as PortalModule)
    : null;
}

/**
 * Where an account lands when it opens the portal.
 *
 * `/` is the worklist, so an agent who has Demo Websites and not Leads must not
 * be sent there — they would meet a refusal screen on the first page after
 * signing in, which reads as a broken account rather than as a deliberate
 * grant. Null means "nowhere they may go", which the home page turns into the
 * refusal screen that is then the honest answer.
 */
export function landingPathFor(access: ModuleAccess): string | null {
  if (access.leads) return "/";
  if (access.demoWebsites) return "/demo-websites";
  return null;
}
