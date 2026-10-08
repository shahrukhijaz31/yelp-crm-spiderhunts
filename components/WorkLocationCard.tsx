"use client";

import { Building2, House } from "lucide-react";

import { formatDuration } from "@/lib/performanceRules";
import {
  WORK_LOCATION_LABELS,
  type LocationStretch,
  type WorkLocationSummary,
} from "@/lib/workLocationRules";
import { formatClock, formatDate } from "@/lib/portalTime";

/**
 * Office and remote time, for an agent or a contributor: totals for each period given, and
 * the stretches of the first one as a list — "Office 9:02–13:10, Remote
 * 14:05–18:30".
 *
 * Read on My time (their own) and on an administrator's per-person time page.
 * Visibility only: nothing here feeds a target, a score or pay.
 *
 * Times are Pakistan time, like every other clock in the portal
 * (`lib/portalTime.ts`).
 */
export default function WorkLocationCard({
  periods,
  listTitle,
}: {
  /** The first period's stretches are the ones listed. */
  periods: Array<{ label: string; summary: WorkLocationSummary }>;
  listTitle: string;
}) {
  const primary = periods[0];
  if (!primary) return null;

  // Newest first, and capped: a month of a busy contributor is a long list,
  // and the totals above already carry the whole period.
  const stretches = [...primary.summary.stretches].reverse().slice(0, 60);

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="text-caption font-medium text-fg-2">Office and remote</h2>
        <p className="text-meta text-fg-4">from the network each signal came from</p>
      </div>

      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
        {periods.map(({ label, summary }) => (
          <Split key={label} label={label} summary={summary} />
        ))}
      </div>

      <div className="border-t border-line px-5 py-3">
        <h3 className="eyebrow">{listTitle}</h3>
        {stretches.length === 0 ? (
          <p className="mt-2 text-ui text-fg-3">Nothing recorded yet.</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-1">
            {stretches.map((stretch) => (
              <StretchRow key={stretch.id} stretch={stretch} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function Split({ label, summary }: { label: string; summary: WorkLocationSummary }) {
  const total = summary.officeSeconds + summary.remoteSeconds;
  const officeShare = total > 0 ? (summary.officeSeconds / total) * 100 : 0;

  return (
    <div className="bg-surface px-5 py-4">
      <p className="eyebrow">{label}</p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <p className="flex items-center gap-1.5 text-ui text-fg-2">
          <Building2 className="h-4 w-4 text-fg-3" strokeWidth={1.75} aria-hidden="true" />
          <span className="tnum font-mono text-fg">{formatDuration(summary.officeSeconds)}</span>
          office
        </p>
        <p className="flex items-center gap-1.5 text-ui text-fg-2">
          <House className="h-4 w-4 text-fg-3" strokeWidth={1.75} aria-hidden="true" />
          <span className="tnum font-mono text-fg">{formatDuration(summary.remoteSeconds)}</span>
          remote
        </p>
      </div>
      {total > 0 && (
        <div
          className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-line"
          role="img"
          aria-label={`${Math.round(officeShare)}% office, ${100 - Math.round(officeShare)}% remote`}
        >
          <span className="h-full bg-viz-office" style={{ width: `${officeShare}%` }} />
          <span className="h-full bg-viz-remote" style={{ width: `${100 - officeShare}%` }} />
        </div>
      )}
    </div>
  );
}

function StretchRow({ stretch }: { stretch: LocationStretch }) {
  const Icon = stretch.location === "office" ? Building2 : House;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ui">
      <span className="flex w-24 items-center gap-1.5 text-fg-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden="true" />
        {WORK_LOCATION_LABELS[stretch.location]}
      </span>
      <span className="tnum font-mono text-caption text-fg-3">
        {dayAndClock(stretch.startedAt)} – {clock(stretch.endedAt)}
      </span>
      <span className="tnum font-mono text-caption text-fg-2">
        {formatDuration(stretch.seconds)}
      </span>
      {stretch.manual && <span className="text-meta text-fg-4">set by hand</span>}
    </li>
  );
}

function clock(iso: string): string {
  return formatClock(iso);
}

function dayAndClock(iso: string): string {
  return `${formatDate(iso)} ${clock(iso)}`;
}
