import type { LeadStats } from "@/lib/leadUtils";

/**
 * The compact strip that replaced the old ten-metric card. Three numbers only
 * — the ones that decide what an agent does next — with everything else moved
 * behind the Breakdown panel and the Reports view.
 */
export default function HeadlineStrip({ stats }: { stats: LeadStats }) {
  return (
    // Tightened from py-5/gap-9: this strip is read once at the top of a
    // session, and every pixel it gives back is a pixel of call list.
    <div className="flex items-end justify-between gap-8 py-4">
      <div className="flex items-end gap-8">
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
    <div className="flex flex-col gap-1.5">
      <span
        className={`display-num text-[34px] leading-none ${
          live ? "text-accent" : "text-fg"
        }`}
      >
        {value}
      </span>
      {/* The label stays an eyebrow — quiet, wide-tracked, and clearly
          subordinate. The numeral is the element; this only names it. */}
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
  return <span aria-hidden="true" className="mb-1.5 h-8 w-px bg-line" />;
}