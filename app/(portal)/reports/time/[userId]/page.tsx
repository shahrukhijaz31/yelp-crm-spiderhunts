import { connection } from "next/server";
import { notFound } from "next/navigation";

import AccessDenied from "@/components/AccessDenied";
import EmployeeTimePanel from "@/components/EmployeeTimePanel";
import { resolveTimesheetRange } from "@/lib/activityRules";
import { requireRole } from "@/lib/authz";
import { employeeTimeDetail } from "@/lib/timeTracking";

/**
 * One employee's tracking detail — ADMIN only.
 *
 * The guard runs before the id in the URL is used for anything, so an agent who
 * guesses a colleague's id gets the refusal screen rather than a page. The id
 * itself is a *filter*: it says which employee is being looked at and never who
 * is looking, and one that names nobody is a 404.
 */
export default async function EmployeeTimePage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { allowed } = await requireRole("ADMIN", "/reports/time");
  if (!allowed) return <AccessDenied />;

  await connection();

  const { userId } = await params;
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

  const detail = await employeeTimeDetail(userId, range);
  if (!detail) notFound();

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <EmployeeTimePanel detail={detail} rangeKey={range.key} />
    </main>
  );
}
