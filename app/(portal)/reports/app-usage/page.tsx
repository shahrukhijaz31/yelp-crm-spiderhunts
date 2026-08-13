import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import AppUsagePanel from "@/components/AppUsagePanel";
import { appUsageReport, knownApplications } from "@/lib/appUsage";
import { NO_APP_USAGE_FILTERS, resolveAppUsageRange } from "@/lib/appUsageRules";
import { requireRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/**
 * App usage — ADMIN only.
 *
 * The guard is the first statement, before a single figure is read, so an agent
 * who types this URL costs a session lookup and gets the refusal screen rather
 * than the markup. `/reports` is already an admin prefix in `lib/access.ts`, so
 * the nav hides it and `proxy.ts` turns the request away at the edge — but
 * neither is what keeps anybody out. This is, and `apiAdmin()` on
 * `/api/reports/app-usage` is, and the two are reached separately: a page guard
 * cannot protect an API an agent calls with curl.
 *
 * The default period is rendered on the server so the screen opens with real
 * figures; the panel recognises the payload it was handed and does not
 * immediately re-request it. Changing a filter is one bounded fetch that returns
 * aggregates only.
 */
export default async function AppUsagePage() {
  const { allowed } = await requireRole("ADMIN", "/reports/app-usage");
  if (!allowed) return <AccessDenied />;

  // The window is relative to the request, so this is a per-request render
  // rather than anything baked at build time.
  await connection();

  const range = resolveAppUsageRange(new URLSearchParams({ range: "last7" }));

  const [payload, employees, applications] = await Promise.all([
    appUsageReport(range, NO_APP_USAGE_FILTERS),
    // Names only: the picker needs enough to label a filter and nothing more,
    // so no email address or account state travels to a screen with no use for
    // one. Every account is offered rather than agents only — an administrator
    // running the Monitor is reported like anybody else, and a picker that
    // silently omitted them would look like missing data.
    prisma.user.findMany({
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }],
    }),
    knownApplications(range),
  ]);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <AppUsagePanel
        initialPayload={payload}
        agents={employees}
        applications={applications}
      />
    </main>
  );
}
