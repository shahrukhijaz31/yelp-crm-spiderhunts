import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import ProductivityPanel from "@/components/ProductivityPanel";
import { resolveTimesheetRange } from "@/lib/activityRules";
import { requireRole } from "@/lib/authz";
import { teamProductivity } from "@/lib/productivity";
import { DEFAULT_PRODUCTIVITY_FILTERS } from "@/lib/productivityRules";
import { prisma } from "@/lib/prisma";

/**
 * Team productivity — ADMIN only.
 *
 * The guard is the first statement, before a single figure is read, so an agent
 * who types this URL costs a session lookup and gets the refusal screen rather
 * than the markup. `/reports` is already an admin prefix in `lib/access.ts`, so
 * the nav hides it and `proxy.ts` turns the request away at the edge — but
 * neither is what keeps anybody out. This is, and `apiAdmin()` on
 * `/api/reports/productivity` is, and the two are reached separately: a page
 * guard cannot protect an API an agent calls with curl.
 *
 * The default period is rendered on the server so the screen opens with real
 * rows; the panel recognises the payload it was handed and does not re-request
 * it. Changing a filter is one bounded fetch that returns aggregates only.
 */
export default async function ProductivityPage() {
  const { allowed } = await requireRole("ADMIN", "/reports/productivity");
  if (!allowed) return <AccessDenied />;

  // The window is relative to the request, so this is a per-request render
  // rather than anything baked at build time.
  await connection();

  const range = resolveTimesheetRange(new URLSearchParams({ range: "last7" }));

  const [payload, agents] = await Promise.all([
    teamProductivity(range, DEFAULT_PRODUCTIVITY_FILTERS),
    // Agents only, and names only: the picker needs enough to label a filter
    // and nothing more, so no email address or account state travels to a
    // screen that has no use for one. Administrators are absent for the same
    // reason they are absent from the table — they are not scored, so offering
    // one as a filter would promise a report that does not exist.
    prisma.user.findMany({
      where: { role: "AGENT" },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }],
    }),
  ]);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ProductivityPanel initialPayload={payload} agents={agents} />
    </main>
  );
}
