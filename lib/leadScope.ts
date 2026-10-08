import type { Role } from "./access";

/**
 * Which leads one person may read and work.
 *
 * Administrators and agents work the shared pool, so their scope is `null` —
 * no narrowing at all. A contributor's is the leads they typed in themselves,
 * matched on `leads.created_by_user_id`, and nothing else: not the scraped
 * pool, not another contributor's leads.
 *
 * **This is the authoritative row filter, and it is applied in the query.**
 * Every read in `lib/leadDb.ts` that a contributor can reach takes a scope and
 * puts it in the `WHERE`, so a lead outside it is never loaded rather than
 * loaded and then hidden. A lead out of scope reads as "not found", never as
 * "forbidden", so its existence is not confirmed either.
 *
 * No imports with a runtime, for the reason `lib/access.ts` gives: client
 * components read the role helpers below to decide what to draw.
 */
export type LeadScope = { createdById: string } | null;

export function leadScopeFor(user: { id: string; role: Role }): LeadScope {
  return user.role === "CONTRIBUTOR" ? { createdById: user.id } : null;
}

/**
 * Who may add a lead by hand (`POST /api/leads`). Administrators, because it
 * is their pool; contributors, because it is the whole of their job. Agents
 * work what is already there.
 */
export function canAddLeads(role: Role): boolean {
  return role === "ADMIN" || role === "CONTRIBUTOR";
}

/**
 * Who may correct a lead's name, phone, website and source. The same two
 * roles, and for a contributor only within their scope — the PATCH reads the
 * lead through it first. An agent's edit stays the whitelist it always was.
 */
export function canEditLeadDetails(role: Role): boolean {
  return canAddLeads(role);
}
