"use client";

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { formatDuration } from "@/lib/performanceRules";
import {
  LOCATION_DAY_OPTIONS,
  type DayLocationTotals,
} from "@/lib/workLocationRules";

/**
 * Office and remote time, one upright gauge per working day, with filters of
 * its own.
 *
 * Its own period and employee rather than the timesheet's, and always one
 * employee — never everybody added together, which would describe nobody.
 * Its own filters because the
 * question is different: "how did this person's week split between the office
 * and home", which wants every day of a week side by side even when the
 * timesheet below is looking at one afternoon. So at least seven days, always,
 * ending today — a day nobody worked is an empty gauge, not a missing one.
 *
 * Each gauge is that day's located time split in two: office filling from the
 * bottom, remote above, a 2px gap between. A 100% stack, because the question
 * is the split; the hours are in the tooltip and under the gauge. Hover or
 * focus shows the exact figures. Colours are the `viz-office` and `viz-remote`
 * tokens, validated for both themes, and the legend names them.
 */
export default function LocationGauges({
  initialDays,
  people,
}: {
  /** The first paint: seven days for `people[0]`. */
  initialDays: DayLocationTotals[];
  /** Everybody whose location is tracked (agents and contributors). */
  people: Array<{ id: string; name: string }>;
}) {
  const [days, setDays] = useState(initialDays);
  const [count, setCount] = useState<number>(LOCATION_DAY_OPTIONS[0]);
  // One person at a time: the split is about how one person's week went, and
  // everybody's hours added together would describe nobody.
  const [agentId, setAgentId] = useState(people[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ticket = useRef(0);

  /**
   * Load a period for a person. Called from the two filters' change handlers
   * rather than an effect: the first paint is the server's, and nothing else
   * changes what is shown. The ticket drops a slow answer to an older choice.
   */
  async function load(nextCount: number, nextAgent: string) {
    if (!nextAgent) return;
    const mine = ++ticket.current;
    const params = new URLSearchParams({ days: String(nextCount), agent: nextAgent });
    setBusy(true);
    try {
      const response = await fetch(`/api/reports/work-location?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { days: DayLocationTotals[] };
      if (mine === ticket.current) {
        setDays(payload.days);
        setError(null);
      }
    } catch {
      if (mine === ticket.current) setError("Could not load office and remote time.");
    } finally {
      if (mine === ticket.current) setBusy(false);
    }
  }

  const totalOffice = days.reduce((sum, day) => sum + day.officeSeconds, 0);
  const totalRemote = days.reduce((sum, day) => sum + day.remoteSeconds, 0);
  const who = people.find((person) => person.id === agentId)?.name ?? "";

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="text-caption font-medium text-fg-2">Office and remote</h2>
          <p className="mt-0.5 text-meta text-fg-4">
            {who} · {formatDuration(totalOffice)} office · {formatDuration(totalRemote)} remote
          </p>
        </div>
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

      {/* --- this section's own filters ---------------------------------- */}
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="location-days" className="field-label">Period</label>
          <SelectBox
            id="location-days"
            value={String(count)}
            onChange={(value) => {
              setCount(Number(value));
              void load(Number(value), agentId);
            }}
            options={LOCATION_DAY_OPTIONS.map((option) => ({
              value: String(option),
              label: `Last ${option} days`,
            }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="location-agent" className="field-label">Employee</label>
          <SelectBox
            id="location-agent"
            value={agentId}
            onChange={(value) => {
              setAgentId(value);
              void load(count, value);
            }}
            options={people.map((person) => ({ value: person.id, label: person.name }))}
          />
        </div>
        <p className="ml-auto self-center text-meta text-fg-4" aria-live="polite">
          {error ? <span className="text-danger">{error}</span> : busy ? "Loading…" : null}
        </p>
      </div>

      {people.length === 0 ? (
        <p className="px-5 py-8 text-center text-ui text-fg-3">
          No agents or contributors yet.
        </p>
      ) : (
        <div className={`overflow-x-auto ${busy ? "opacity-60" : ""}`}>
          {/* The days share the full width rather than bunching at the left,
              and the tube narrows as the count grows so 30 still fit. */}
          <ul
            className="grid px-5 py-4"
            style={{
              // A week gets columns of at most 120px spread evenly, so seven
              // capsules sit as a set rather than one per wide column. Longer
              // periods share the width outright.
              gridTemplateColumns:
                days.length <= 7
                  ? `repeat(${days.length}, minmax(72px, 120px))`
                  : `repeat(${days.length}, minmax(${days.length > 14 ? 40 : 56}px, 1fr))`,
              justifyContent: "space-evenly",
            }}
          >
            {days.map((day, index) => (
              <Gauge
                key={day.day}
                day={day}
                tube={days.length > 14 ? "w-4" : days.length > 7 ? "w-7" : "w-10"}
                tipSide={index < days.length / 2 ? "right" : "left"}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Gauge({
  day,
  tube,
  tipSide,
}: {
  day: DayLocationTotals;
  /** Tube width class, chosen by how many days share the row. */
  tube: string;
  /** Which side the tooltip opens on, so it stays inside the panel. */
  tipSide: "left" | "right";
}) {
  const [hover, setHover] = useState(false);
  const total = day.officeSeconds + day.remoteSeconds;
  const officePct = total > 0 ? Math.round((day.officeSeconds / total) * 100) : 0;
  const remotePct = total > 0 ? 100 - officePct : 0;
  const { weekday, month, dayOfMonth, date } = dayLabel(day.day);
  const summary =
    total > 0
      ? `Office ${formatDuration(day.officeSeconds)} · Remote ${formatDuration(day.remoteSeconds)}`
      : "Nothing recorded";

  return (
    <li className="relative flex min-w-0 flex-col items-center">
      {/* The whole column is the hit target — wider than the 24px tube — and
          focusable, so the split is reachable from the keyboard too. */}
      <button
        type="button"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-label={`${weekday} ${date}: ${total > 0 ? `${officePct}% office, ${remotePct}% remote. ` : ""}${summary}.`}
        className="flex flex-col items-center gap-1.5 rounded-md px-1 pt-1 outline-offset-2"
      >
        <span
          aria-hidden="true"
          className={`flex h-44 ${tube} flex-col justify-end gap-0.5 overflow-hidden rounded-full border border-line-2 bg-recessed p-0.5`}
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
        <span className="text-caption font-medium text-fg-2">{weekday}</span>
        <span className="flex flex-col items-center text-meta leading-tight text-fg-3">
          <span>{month}</span>
          <span className="tnum">{dayOfMonth}</span>
        </span>
        <span className="tnum font-mono text-meta text-fg-4">
          {total > 0 ? `${officePct}%` : "—"}
        </span>
      </button>

      {hover && (
        <span
          role="tooltip"
          className={`panel-float pointer-events-none absolute top-6 z-20 w-max px-3 py-2 text-caption ${
            tipSide === "right" ? "left-[calc(50%+1.5rem)]" : "right-[calc(50%+1.5rem)]"
          }`}
        >
          <span className="block font-medium text-fg">
            {weekday} {date}
          </span>
          {total > 0 ? (
            <>
              <span className="mt-1 flex items-center gap-1.5 text-fg-2">
                <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-viz-office" />
                Office <span className="tnum font-mono text-fg">{formatDuration(day.officeSeconds)}</span>
                <span className="text-fg-4">({officePct}%)</span>
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-fg-2">
                <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-viz-remote" />
                Remote <span className="tnum font-mono text-fg">{formatDuration(day.remoteSeconds)}</span>
                <span className="text-fg-4">({remotePct}%)</span>
              </span>
            </>
          ) : (
            <span className="mt-1 block text-fg-3">Nothing recorded</span>
          )}
        </span>
      )}
    </li>
  );
}

/**
 * `2026-10-06` -> `Tue`, `Oct`, `6`. A calendar day, so read in UTC, not
 * converted. Month and day are separate so they can sit on separate lines —
 * "Sep 30" wraps in a narrow column where "Oct 1" does not, and the row of
 * labels stops lining up.
 */
function dayLabel(iso: string): { weekday: string; month: string; dayOfMonth: string; date: string } {
  const [year, month, day] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  const monthName = at.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return {
    weekday: at.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
    month: monthName,
    dayOfMonth: String(day),
    date: `${monthName} ${day}`,
  };
}

function SelectBox({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <span className="relative">
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ui-field h-9 min-w-[152px] cursor-pointer appearance-none pr-8"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </span>
  );
}
