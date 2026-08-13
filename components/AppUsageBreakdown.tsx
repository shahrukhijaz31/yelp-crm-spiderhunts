import { formatDuration } from "@/lib/performanceRules";
import type { AppUsageApplication } from "@/lib/appUsageRules";

/**
 * The application table: what ran, for how long, and what share of the time.
 *
 * A plain component with no hooks and no `"use client"` directive, so the same
 * table renders on the employee detail page (a server component) and inside the
 * App Usage panel (a client one). One implementation means the two screens
 * cannot drift into rounding or labelling the same figures differently.
 *
 * **The bar is the share of recorded app time, not of the working day.** Those
 * are two different denominators and the panel above this says which is which;
 * see the note on {@link AppUsageApplication}. The row also carries the share of
 * tracked time as text, because "Chrome was 55% of what the Monitor saw" and
 * "Chrome was 41% of the shift" are both worth knowing and neither implies the
 * other.
 *
 * **No application is judged.** There is no colour scale from good to bad, no
 * category and no icon set that would smuggle one in — every bar is the same
 * accent, and the only ordering is by time. `Other` is the one styled
 * differently, because it is a fold rather than an application.
 */
export default function AppUsageBreakdown({
  applications,
  emptyMessage = "No application usage has been recorded for this period.",
}: {
  applications: AppUsageApplication[];
  emptyMessage?: string;
}) {
  if (applications.length === 0) {
    return <p className="px-5 py-8 text-center text-ui text-fg-3">{emptyMessage}</p>;
  }

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[560px]">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="eyebrow px-5 py-2 text-left">
              Application
            </th>
            <th scope="col" className="eyebrow px-3 py-2 text-right">
              Total time
            </th>
            <th scope="col" className="eyebrow px-3 py-2 text-right">
              Share
            </th>
            <th scope="col" className="eyebrow px-3 py-2 text-right">
              Of tracked
            </th>
            <th scope="col" className="eyebrow w-[34%] px-5 py-2 text-left">
              <span className="sr-only">Proportion</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => (
            <tr
              key={application.applicationName}
              className="border-b border-line last:border-b-0"
            >
              <td className="px-5 py-3 text-cell text-fg">
                {application.other ? (
                  <span className="text-fg-3">
                    Other
                    <span className="ml-2 text-meta text-fg-4">
                      everything outside the list above
                    </span>
                  </span>
                ) : (
                  <>
                    {application.applicationName}
                    {application.segments > 0 && (
                      <span className="ml-2 text-meta text-fg-4">
                        {application.segments.toLocaleString()}{" "}
                        {application.segments === 1 ? "session" : "sessions"}
                      </span>
                    )}
                  </>
                )}
              </td>
              <td className="tnum px-3 py-3 text-right font-mono text-num text-fg">
                {formatDuration(application.seconds)}
              </td>
              <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">
                {application.shareOfAppTime}%
              </td>
              <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-3">
                {application.shareOfTrackedTime}%
              </td>
              <td className="px-5 py-3">
                <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <span
                    className={`block h-full rounded-full ${application.other ? "bg-fg-4/50" : "bg-accent/70"}`}
                    style={{ width: `${Math.max(2, application.shareOfAppTime)}%` }}
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
