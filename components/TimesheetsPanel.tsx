"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { ActivityPill } from "./TimeTrackingPanel";
import type { TimesheetRow } from "@/lib/activityRules";
import { formatDuration, RANGE_LABELS, type RangeKey } from "@/lib/performanceRules";
import type { TimeReport, TimeReportFilters } from "@/lib/timeTracking";

/**
 * Timesheets — the administrator's period report.
 *
 * Two tables from one request, and that is deliberate: the per-employee summary
 * and the day-by-day rows are computed from the same resolved range in the same
 * response (`/api/reports/timesheets`), so a total that disagrees with the days
 * beneath it is not a state this screen can reach.
 *
 * **The filters drive one fetch.** Nothing is filtered in the browser, because
 * the browser never has more than the aggregate — the response is one row per
 * employee plus one per employee per worked day, whether the tables behind it
 * hold a thousand activity rows or ten million. That is the same property the
 * worklist has and for the same reason.
 *
 * **Tracked, Active and Idle are three different things** and the screen says
 * so under the table rather than hoping the column headings carry it. Tracked
 * is the work session — the portal's own record of being signed in and working.
 * Active is the part of it with keyboard or mouse input. Idle is the remainder,
 * *including* any time the desktop Monitor was not running, because the portal
 * will not claim input it never observed.
 */

const PERIODS: RangeKey[] = ["today", "yesterday", "last7", "last30", "custom"];

const STATUSES: Array<{ value: string; label: string }> = [
  { value: "all", label: "Any status" },
  { value: "working", label: "Working now" },
  { value: "inactive", label: "Inactive now" },
  { value: "offline", label: "Offline now" },
];

export interface TimesheetPayload {
  range: { key: RangeKey; from: string; to: string; label: string };
  report: TimeReport;
  timesheet: TimesheetRow[];
}

export default function TimesheetsPanel({
  initialPayload,
  agents,
}: {
  initialPayload: TimesheetPayload;
  agents: Array<{ id: string; name: string; role: string }>;
}) {
  const [payload, setPayload] = useState(initialPayload);
  const [rangeKey, setRangeKey] = useState<RangeKey>(initialPayload.range.key);
  const [customFrom, setCustomFrom] = useState(initialPayload.range.from);
  const [customTo, setCustomTo] = useState(initialPayload.range.to);
  const [agentId, setAgentId] = useState("all");
  const [minActivity, setMinActivity] = useState("");
  const [status, setStatus] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useRef(0);
  // The payload the server already rendered. Skipping the first fetch means the
  // screen paints with real rows and does not immediately ask for them again.
  const primed = useRef(true);

  const load = useCallback(async () => {
    const ticket = ++request.current;
    setBusy(true);

    const params = new URLSearchParams({ range: rangeKey });
    if (rangeKey === "custom") {
      params.set("from", customFrom);
      params.set("to", customTo);
    }
    if (agentId !== "all") params.set("agent", agentId);
    if (minActivity !== "") params.set("minActivity", minActivity);
    if (status !== "all") params.set("status", status);

    try {
      const response = await fetch(`/api/reports/timesheets?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as TimesheetPayload;
      if (ticket === request.current) {
        setPayload(next);
        setError(null);
      }
    } catch {
      if (ticket === request.current) setError("Could not load the timesheet.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }, [rangeKey, customFrom, customTo, agentId, minActivity, status]);

  useEffect(() => {
    if (primed.current) {
      primed.current = false;
      return;
    }
    void load();
  }, [load]);

  const { report, timesheet } = payload;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header>
        <h1 className="page-title">Timesheets</h1>
        <p className="mt-2 page-intro">
          Hours from the portal&rsquo;s own work sessions, with the activity
          observed inside them. Every figure is aggregated in the database —
          nothing here is an estimate and nothing is counted in the browser.
        </p>
      </header>

      {/* --- filters ------------------------------------------------------ */}
      <section
        aria-label="Filters"
        className="panel flex flex-wrap items-end gap-3 px-4 py-3"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="period" className="field-label">Period</label>
          <Select
            id="period"
            value={rangeKey}
            onChange={(value) => setRangeKey(value as RangeKey)}
            options={PERIODS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))}
          />
        </div>

        {rangeKey === "custom" && (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="from" className="field-label">From</label>
              <input
                id="from"
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="ui-field h-9 w-[152px]"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="to" className="field-label">To</label>
              <input
                id="to"
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
                className="ui-field h-9 w-[152px]"
              />
            </div>
          </>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="agent" className="field-label">Employee</label>
          <Select
            id="agent"
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: "all", label: "All employees" },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.role === "ADMIN" ? `${agent.name} (admin)` : agent.name,
              })),
            ]}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="minActivity" className="field-label">Min activity</label>
          <input
            id="minActivity"
            type="number"
            min={0}
            max={100}
            step={5}
            value={minActivity}
            placeholder="any"
            onChange={(event) => setMinActivity(event.target.value)}
            className="ui-field h-9 w-[104px]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="field-label">Status</label>
          <Select id="status" value={status} onChange={setStatus} options={STATUSES} />
        </div>

        <p className="ml-auto self-center text-meta text-fg-4" aria-live="polite">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : busy ? (
            "Loading…"
          ) : (
            `${payload.range.from} → ${payload.range.to}`
          )}
        </p>
      </section>

      {/* --- per-employee summary ---------------------------------------- */}
      <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Summary</h2>
          <p className="text-meta text-fg-4">
            {report.rows.length} {report.rows.length === 1 ? "employee" : "employees"}
          </p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-5 py-2 text-left">Employee</th>
                <Head>Tracked</Head>
                <Head>Active</Head>
                <Head>Idle</Head>
                <Head>Activity</Head>
                <Head>Sessions</Head>
                <Head>Meetings</Head>
                <Head>Shots</Head>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.userId} className="border-b border-line last:border-b-0">
                  <td className="px-5 py-3">
                    <Link
                      href={`/reports/time/${row.userId}`}
                      className="text-cell font-medium text-fg underline-offset-2 hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.online && (
                      <span className="ml-2 text-meta text-success">online</span>
                    )}
                  </td>
                  <Cell>{formatDuration(row.trackedSeconds)}</Cell>
                  <Cell>{formatDuration(row.activeSeconds)}</Cell>
                  <Cell>{formatDuration(row.idleSeconds)}</Cell>
                  <td className="px-3 py-3 text-right">
                    <ActivityPill value={row.activityPercentage} />
                  </td>
                  <Cell>{row.sessions}</Cell>
                  <Cell>
                    {row.meetingsBooked}
                    {row.meetingsCompleted > 0 && (
                      <span className="text-fg-4"> / {row.meetingsCompleted}</span>
                    )}
                  </Cell>
                  <Cell>{row.screenshots}</Cell>
                </tr>
              ))}
              {report.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-ui text-fg-3">
                    No employees match these filters.
                  </td>
                </tr>
              )}
            </tbody>
            {report.rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-line-2">
                  <td className="px-5 py-3 text-cell font-semibold text-fg">Total</td>
                  <Cell>{formatDuration(report.totals.trackedSeconds)}</Cell>
                  <Cell>{formatDuration(report.totals.activeSeconds)}</Cell>
                  <Cell>{formatDuration(report.totals.idleSeconds)}</Cell>
                  <td className="px-3 py-3 text-right">
                    <ActivityPill value={report.totals.activityPercentage} />
                  </td>
                  <Cell>{report.totals.sessions}</Cell>
                  <Cell>{report.totals.meetingsBooked}</Cell>
                  <Cell>{report.totals.screenshots}</Cell>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* --- day by day --------------------------------------------------- */}
      <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Day by day</h2>
          <p className="text-meta text-fg-4">
            {timesheet.length} {timesheet.length === 1 ? "day worked" : "days worked"}
          </p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-5 py-2 text-left">Date</th>
                <th scope="col" className="eyebrow px-3 py-2 text-left">Employee</th>
                <th scope="col" className="eyebrow px-3 py-2 text-right">First in</th>
                <th scope="col" className="eyebrow px-3 py-2 text-right">Last out</th>
                <Head>Tracked</Head>
                <Head>Active</Head>
                <Head>Idle</Head>
                <Head>Activity</Head>
                <Head>Sessions</Head>
              </tr>
            </thead>
            <tbody>
              {timesheet.map((row) => (
                <tr key={`${row.userId}-${row.day}`} className="border-b border-line last:border-b-0">
                  <td className="px-5 py-3 text-cell text-fg">{longDay(row.day)}</td>
                  <td className="px-3 py-3 text-cell text-fg-2">{row.name}</td>
                  <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">
                    {row.firstStartedAt ? clock(row.firstStartedAt) : "—"}
                  </td>
                  <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">
                    {row.lastEndedAt ? clock(row.lastEndedAt) : <span className="text-success">open</span>}
                  </td>
                  <Cell>{formatDuration(row.trackedSeconds)}</Cell>
                  <Cell>{formatDuration(row.activeSeconds)}</Cell>
                  <Cell>{formatDuration(row.idleSeconds)}</Cell>
                  <td className="px-3 py-3 text-right">
                    <ActivityPill value={row.activityPercentage} />
                  </td>
                  <Cell>{row.sessions}</Cell>
                </tr>
              ))}
              {timesheet.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-8 text-center text-ui text-fg-3">
                    Nothing was worked in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-meta text-fg-4">
        <strong className="font-medium text-fg-3">Tracked</strong> is time in a
        work session — the portal&rsquo;s record of being signed in and working,
        and the basis of every total here.{" "}
        <strong className="font-medium text-fg-3">Active</strong> is the part of
        it where keyboard or mouse input was observed.{" "}
        <strong className="font-medium text-fg-3">Idle</strong> is the rest,
        including any stretch when the desktop Monitor was not running. Activity
        measures input only and is never used to calculate tracked hours.
      </p>
    </div>
  );
}

/** A native `<select>`, styled — the same one the other report panels use. */
function Select({
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
    <span className="relative inline-flex items-center">
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ui-field h-9 min-w-[152px] appearance-none pr-8"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-4"
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="eyebrow px-3 py-2 text-right">
      {children}
    </th>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">{children}</td>;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** `2026-08-12` -> `Wed 12 Aug`. */
function longDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export type { TimeReportFilters };
