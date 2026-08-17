import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import ReportsPanel from "@/components/ReportsPanel";
import { requireRole } from "@/lib/authz";
import { leadStats } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";

/**
 * Reports — ADMIN only.
 *
 * The guard is here, in the server component, rather than only in the nav bar
 * or the proxy: this is the layer that decides whether the panel is rendered
 * at all, so an agent who types the URL gets the refusal screen and never the
 * markup behind it. It runs *before* the counts below, so a refused agent costs
 * a session lookup and nothing else.
 *
 * This screen used to read the whole table and count it in the browser. Every
 * figure on it is an aggregate — a total, a group-by, two date ranges — and
 * Postgres computes all of them in one transaction (`leadStats`), so what
 * travels to the browser is now a handful of numbers instead of the workspace.
 * That is also what makes the report *correct at one instant*: the counts come
 * from a single transaction rather than from a table read that a concurrent
 * edit could land in the middle of.
 *
 * `connection()` for the same reason the portal layout has one: the callback
 * figures are relative to "now", so this must not be answered from a render
 * performed at build time.
 */
export default async function ReportsPage() {
  const { allowed } = await requireRole("ADMIN", "/reports");
  if (!allowed) return <AccessDenied />;

  await connection();

  const today = todayIso();
  const stats = await leadStats(today);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ReportsPanel stats={stats} today={today} />
    </main>
  );
}
