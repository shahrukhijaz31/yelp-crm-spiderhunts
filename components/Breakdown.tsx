import type { LeadStats } from "@/lib/leadUtils";
import {
  CALL_STATUSES,
  CALL_STATUS_DOTS,
  CALL_STATUS_SHORT_LABELS,
} from "@/lib/types";

/**
 * The detail an agent does *not* need mid-call: the full status breakdown and
 * the list-quality counts. Collapsed behind the Breakdown toggle on the
 * worklist, and shown expanded on the Reports view.
 */
export default function Breakdown({
  stats,
  size = "compact",
}: {
  stats: LeadStats;
  size?: "compact" | "full";
}) {
  const full = size === "full";

  return (
    <div
      className={`grid gap-x-10 gap-y-6 ${
        full ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]" : "grid-cols-[minmax(0,1fr)_260px]"
      }`}
    >
      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="eyebrow">Status mix</h2>
          <p className="text-[12px] text-fg-3">
            <span className="tnum font-mono text-fg-2">{stats.called}</span> of{" "}
            <span className="tnum font-mono text-fg-2">{stats.total}</span> worked
            <span className="ml-2 text-fg-4">
              {stats.total === 0
                ? "0%"
                : `${Math.round((stats.called / stats.total) * 100)}%`}
            </span>
          </p>
        </div>

        {/* All seven counts as one object rather than seven equal boxes. */}
        <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-rail">
          {CALL_STATUSES.map((status) => {
            const count = stats.byStatus[status];
            if (count === 0) return null;
            return (
              <div
                key={status}
                title={`${CALL_STATUS_SHORT_LABELS[status]}: ${count}`}
                style={{ flexGrow: count }}
                className={`h-full ${CALL_STATUS_DOTS[status]} ${
                  status === "not_called" ? "opacity-40" : ""
                }`}
              />
            );
          })}
        </div>

        <div
          className={`mt-4 grid gap-x-8 gap-y-2 ${full ? "max-w-[640px] grid-cols-3" : "max-w-[820px] grid-cols-4"}`}
        >
          {CALL_STATUSES.map((status) => (
            <div key={status} className="flex items-baseline gap-2">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${CALL_STATUS_DOTS[status]}`}
              />
              <span
                className={`tnum font-mono font-semibold text-fg ${full ? "text-[14px]" : "text-[12px]"}`}
              >
                {stats.byStatus[status]}
              </span>
              <span
                className={`truncate text-fg-3 ${full ? "text-[13px]" : "text-[12px]"}`}
              >
                {CALL_STATUS_SHORT_LABELS[status]}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="border-l border-line pl-8">
        <h2 className="eyebrow">List quality</h2>
        <dl className="mt-3 flex flex-col gap-2.5">
          {/* Phone gaps and duplicates are filtered out at ingest, so they
              would sit at a permanent zero here. Website is the gap that
              survives cleaning. */}
          <QualityRow label="Missing website" value={stats.missingWebsite} tone="warn" full={full} />
          <QualityRow label="Callback today" value={stats.callbackDueToday} tone="accent" full={full} />
          <QualityRow label="Overdue" value={stats.callbackOverdue} tone="accent" full={full} />
        </dl>
      </section>
    </div>
  );
}

function QualityRow({
  label,
  value,
  tone,
  full,
}: {
  label: string;
  value: number;
  tone: "warn" | "dup" | "accent";
  full: boolean;
}) {
  const dot =
    tone === "warn" ? "bg-warn" : tone === "dup" ? "bg-dup" : "bg-accent";

  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${value > 0 ? dot : "bg-line-2"}`}
      />
      <dt className={`text-fg-3 ${full ? "text-[13px]" : "text-[12px]"}`}>
        {label}
      </dt>
      <dd
        className={`tnum ml-auto font-mono font-medium ${
          value > 0 ? "text-fg" : "text-fg-4"
        } ${full ? "text-[15px]" : "text-[13px]"}`}
      >
        {value}
      </dd>
    </div>
  );
}