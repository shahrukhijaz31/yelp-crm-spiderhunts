import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import AccessDenied from "@/components/AccessDenied";
import AppUsageBreakdown from "@/components/AppUsageBreakdown";
import EmployeeTimePanel from "@/components/EmployeeTimePanel";
import { resolveTimesheetRange } from "@/lib/activityRules";
import { employeeAppUsage } from "@/lib/appUsage";
import { requireRole } from "@/lib/authz";
import { formatDuration } from "@/lib/performanceRules";
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

  /*
   * The tracking record and the app usage for the same window, read together.
   *
   * Two calls rather than one because they are two features: `employeeTimeDetail`
   * is unchanged and still knows nothing about applications, and app usage is a
   * separate data source under the same work session. Neither read affects the
   * other's figures, and removing this one would leave the screen exactly as it
   * was before app usage existed.
   */
  const [detail, usage] = await Promise.all([
    employeeTimeDetail(userId, range),
    employeeAppUsage(userId, range),
  ]);
  if (!detail) notFound();

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <EmployeeTimePanel detail={detail} rangeKey={range.key} />

      {/* App usage for the same period, beneath the record it belongs to.
          Aggregates only — one row per application, never one per segment —
          with the full screen, its filters and the daily timeline one link
          away. */}
      <section className="panel mx-auto mt-5 w-full max-w-6xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div>
            <h2 className="text-caption font-medium text-fg-2">App usage</h2>
            <p className="mt-0.5 text-meta text-fg-4">
              foreground applications during this period · no window titles or
              URLs are recorded, and nothing here is classified
            </p>
          </div>
          <p className="text-meta text-fg-4">
            <span className="tnum font-mono text-fg-3">
              {formatDuration(usage?.recordedSeconds ?? 0)}
            </span>{" "}
            reported of{" "}
            <span className="tnum font-mono text-fg-3">
              {formatDuration(detail.trackedSeconds)}
            </span>{" "}
            tracked ·{" "}
            <Link
              // `from`/`to` travel with the key so a custom period survives the
              // hop — without them `range=custom` would resolve back to today.
              href={`/reports/app-usage?agent=${detail.user.id}&range=${range.key}&from=${range.fromDay}&to=${range.toDay}`}
              className="underline-offset-2 hover:text-fg hover:underline"
            >
              open the full report
            </Link>
          </p>
        </div>

        <AppUsageBreakdown
          applications={usage?.applications ?? []}
          emptyMessage="No application usage has been recorded for this employee in this period. This needs the SpiderHunts Monitor running on their workstation."
        />
      </section>
    </main>
  );
}
