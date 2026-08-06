import type { LeadStats } from "@/lib/leadUtils";

/**
 * The compact strip that replaced the old ten-metric card. Three numbers only
 * — the ones that decide what an agent does next — with everything else moved
 * behind the Breakdown panel and the Reports view.
 */
export default function HeadlineStrip({ stats }: { stats: LeadStats }) {
  return (
    <div className="flex items-end justify-between gap-8 py-5">
      <div className="flex items-end gap-9">
        <Headline value={stats.total} label="Total leads" />
        <Divider />
        <Headline
          value={stats.callbackDueToday}
          label="Callback today"
          live={stats.callbackDueToday > 0}
        />
        <Divider />
        <Headline
          value={stats.callbackOverdue}
          label="Overdue"
          live={stats.callbackOverdue > 0}
        />
      </div>
    </div>
  );
}

function Headline({
  value,
  label,
  live,
}: {
  value: number;
  label: string;
  live?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span
        className={`display-num text-[40px] leading-none ${
          live ? "text-accent" : "text-fg"
        }`}
      >
        {value}
      </span>
      <span className="eyebrow flex items-center gap-1.5 whitespace-nowrap">
        {live && (
          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-accent" />
        )}
        {label}
      </span>
    </div>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mb-1.5 h-9 w-px bg-line" />;
}