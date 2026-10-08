"use client";

import { useState } from "react";

import { formatDuration } from "@/lib/performanceRules";
import type { PersonLocationTotals } from "@/lib/workLocationRules";

/**
 * Office and remote time per person, as a row of upright gauges.
 *
 * Each gauge is one person's located time for the period, split in two: office
 * filling from the bottom, remote above it, a 2px gap between. A 100% stack
 * rather than hours, because the question is "how much of their time was at
 * home", and a bar of absolute hours would make a part-timer's 100% remote
 * look smaller than a full-timer's 20%. The hours are in the tooltip, under the
 * gauge, and in the Summary table beside it.
 *
 * Hover or focus shows the exact split. Colours are the `viz-office` and
 * `viz-remote` tokens, validated for both themes; the legend names them, so
 * colour is never the only way to tell the halves apart.
 */
export default function LocationGauges({
  people,
  busy = false,
}: {
  people: PersonLocationTotals[];
  busy?: boolean;
}) {
  return (
    <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="text-caption font-medium text-fg-2">Office and remote</h2>
        <div className="flex items-center gap-4 text-meta text-fg-3">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-viz-office" />
            Office
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-viz-remote" />
            Remote
          </span>
        </div>
      </div>

      {people.length === 0 ? (
        <p className="px-5 py-8 text-center text-ui text-fg-3">
          No office or remote time recorded in this period.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-x-8 gap-y-6 px-5 py-5">
          {people.map((person) => (
            <Gauge key={person.userId} person={person} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Gauge({ person }: { person: PersonLocationTotals }) {
  const [hover, setHover] = useState(false);
  const total = person.officeSeconds + person.remoteSeconds;
  const officePct = total > 0 ? Math.round((person.officeSeconds / total) * 100) : 0;
  const remotePct = 100 - officePct;
  const summary = `Office ${formatDuration(person.officeSeconds)} · Remote ${formatDuration(person.remoteSeconds)}`;

  return (
    <li className="relative flex w-20 flex-col items-center">
      {/* The whole column is the hit target — bigger than the 24px tube — and
          focusable, so the split is reachable from the keyboard too. */}
      <button
        type="button"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-label={`${person.name}: ${officePct}% office, ${remotePct}% remote. ${summary}.`}
        className="flex flex-col items-center gap-2 rounded-md px-2 pt-1 outline-offset-2"
      >
        <span
          aria-hidden="true"
          className="flex h-36 w-6 flex-col justify-end gap-0.5 overflow-hidden rounded-full border border-line-2 bg-recessed p-0.5"
        >
          {remotePct > 0 && (
            <span
              className="min-h-1 w-full rounded-full bg-viz-remote"
              style={{ flexGrow: remotePct, flexBasis: 0 }}
            />
          )}
          {officePct > 0 && (
            <span
              className="min-h-1 w-full rounded-full bg-viz-office"
              style={{ flexGrow: officePct, flexBasis: 0 }}
            />
          )}
        </span>
        <span className="max-w-20 truncate text-caption text-fg-2" title={person.name}>
          {person.name}
        </span>
        <span className="tnum font-mono text-meta text-fg-3">{officePct}% office</span>
      </button>

      {hover && (
        <span
          role="tooltip"
          className="panel-float pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 w-max -translate-x-1/2 px-3 py-2 text-caption"
        >
          <span className="block font-medium text-fg">{person.name}</span>
          <span className="mt-1 flex items-center gap-1.5 text-fg-2">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-viz-office" />
            Office <span className="tnum font-mono text-fg">{formatDuration(person.officeSeconds)}</span>
            <span className="text-fg-4">({officePct}%)</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-fg-2">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-viz-remote" />
            Remote <span className="tnum font-mono text-fg">{formatDuration(person.remoteSeconds)}</span>
            <span className="text-fg-4">({remotePct}%)</span>
          </span>
        </span>
      )}
    </li>
  );
}
