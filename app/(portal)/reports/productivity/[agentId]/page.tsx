import { connection } from "next/server";
import { notFound } from "next/navigation";

import AccessDenied from "@/components/AccessDenied";
import AgentProductivityPanel from "@/components/AgentProductivityPanel";
import { resolveTimesheetRange } from "@/lib/activityRules";
import { requireRole } from "@/lib/authz";
import { agentProductivity } from "@/lib/productivity";

/**
 * One agent's productivity, with the working shown — ADMIN only.
 *
 * The guard runs before the id in the URL is used for anything, so an agent who
 * guesses a colleague's id — or their own — gets the refusal screen rather than
 * a page. The id is a *filter*: it says whose score is being looked at and never
 * who is looking. An id that names nobody is a 404, and so is one that names an
 * administrator, because administrators are not scored.
 */
export default async function AgentProductivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { allowed } = await requireRole("ADMIN", "/reports/productivity");
  if (!allowed) return <AccessDenied />;

  await connection();

  const { agentId } = await params;
  const search = await searchParams;

  // Through the same resolver the API uses, so a period means the same thing
  // whether the screen was rendered here or fetched.
  const range = resolveTimesheetRange(
    new URLSearchParams(
      Object.entries(search).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value] as [string, string]] : [],
      ),
    ),
  );

  const detail = await agentProductivity(agentId, range);
  if (!detail) notFound();

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <AgentProductivityPanel initialDetail={detail} />
    </main>
  );
}
