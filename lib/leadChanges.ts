import type { LeadChangeEntry } from "./leadChangeRules";
import { prisma } from "./prisma";

/**
 * Reading a lead's change history. The writing happens inside the same
 * transaction as the edit it describes (`updateLeadFields` and `createLead` in
 * `lib/leadDb.ts`), so a saved edit and its history row cannot disagree.
 */

/**
 * How many entries the Activity panel is sent. A lead worked for months is
 * still a few dozen saves; this only stops one pathological lead from turning
 * the workspace into a megabyte page.
 */
const HISTORY_LIMIT = 300;

/** This lead's history, newest first. Callers have already checked scope. */
export async function listLeadChanges(leadId: string): Promise<LeadChangeEntry[]> {
  const rows = await prisma.leadChange.findMany({
    where: { leadId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: {
      id: true,
      field: true,
      oldValue: true,
      newValue: true,
      createdAt: true,
      user: { select: { id: true, name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    at: row.createdAt.toISOString(),
    by: row.user,
  }));
}
