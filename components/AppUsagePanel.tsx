"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

import AppUsageBreakdown from "./AppUsageBreakdown";
import { formatActivity } from "@/lib/activityRules";
import type { AppUsageReport, AppUsageTimeline } from "@/lib/appUsageRules";
import { formatDuration, RANGE_LABELS, type RangeKey } from "@/lib/performanceRules";

/**
 * App usage — ADMIN only, and the screen the feature exists for.
 *
 * **The security note first.** Everything here arrives from
 * `GET /api/reports/app-usage`, which is behind `apiAdmin()` and answers 403 to
 * an agent holding a perfectly valid session. Nothing in this component keeps an
 * agent out; the page above it refuses first, the endpoint refuses again, and if
 * every line of this file were pasted into an agent's browser it would fetch
 * nothing but a 403.
 *
 * **Nothing here is calculated and nothing is invented.** Every figure arrives
 * aggregated from Postgres; this component formats and lays out. Filtering is a
 * query parameter on one bounded fetch, never a pass over a client-side array —
 * the browser is never sent the usage rows, only the totals, so the response is
 * the same size for a month of a whole team as for one agent's morning.
 *
 * **No application is judged.** There is no productive/unproductive split, no
 * category, no colour scale and no score. The screen reports how long things
 * were on screen and says so in words, because a reader will otherwise supply
 * the judgement themselves.
 *
 * **Two denominators, both named.** Share is of the recorded app time (the rows
 * add to 100%); coverage is how much of the tracked working day the Monitor
 * reported an application for at all. A screen that showed only the first would
 * quietly present four hours of reported usage as a whole eight-hour shift.
 */

const PERIODS: RangeKey[] = ["today", "yesterday", "last7", "last30", "custom"];

export default function AppUsagePanel({
  initialPayload,
  agents,
  applications,
}: {
  initialPayload: AppUsageReport;
  agents: Array<{ id: string; name: string }>;
  /** Labels seen recently, for the picker. A filter list, not a taxonomy. */
  applications: string[];
}) {
  const [payload, setPayload] = useState(initialPayload);
  const [rangeKey, setRangeKey] = useState<RangeKey>(initialPayload.range.key as RangeKey);
  const [customFrom, setCustomFrom] = useState(initialPayload.range.from);
  const [customTo, setCustomTo] = useState(initialPayload.range.to);
  const [agentId, setAgentId] = useState(initialPayload.filters.agent ?? "all");
  const [application, setApplication] = useState(initialPayload.filters.application ?? "all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<AppUsageTimeline | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  // The in-flight request, so a response that lands after a newer one cannot
  // overwrite it — the same guard the other report panels use.
  const request = useRef(0);
  // The payload the server already rendered. Skipping the first fetch means the
  // screen paints with real rows and does not immediately ask for them again.
  const primed = useRef(true);

  /** The current filters as a query string. One place, so the two fetches agree. */
  const query = useCallback(() => {
    const params = new URLSearchParams({ range: rangeKey });
    if (rangeKey === "custom") {
      params.set("from", customFrom);
      params.set("to", customTo);
    }
    if (agentId !== "all") params.set("agent", agentId);
    if (application !== "all") params.set("application", application);
    return params;
  }, [rangeKey, customFrom, customTo, agentId, application]);

  const load = useCallback(async () => {
    const ticket = ++request.current;
    setBusy(true);

    try {
      const response = await fetch(`/api/reports/app-usage?${query()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as AppUsageReport;
      if (ticket === request.current) {
        setPayload(next);
        setError(null);
      }
    } catch {
      if (ticket === request.current) setError("Could not load app usage.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    if (primed.current) {
      primed.current = false;
      return;
    }
    // The filters changed, so any timeline on screen describes the old ones.
    setTimeline(null);
    void load();
  }, [load]);

  /**
   * The timeline, fetched only when it is asked for.
   *
   * It is the one read in this feature that returns a row per segment, so it is
   * never part of the report's own payload: an administrator scanning the
   * application table should not pay for several hundred rows they did not ask
   * to see.
   */
  const loadTimeline = useCallback(async () => {
    if (agentId === "all") return;
    setTimelineError(null);

    try {
      const response = await fetch(`/api/reports/app-usage/timeline?${query()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));
      setTimeline((await response.json()) as AppUsageTimeline);
    } catch {
      setTimelineError("Could not load the timeline.");
    }
  }, [agentId, query]);

  const { summary, employee } = payload;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header>
        <h1 className="page-title">App usage</h1>
        <p className="mt-2 page-intro">
          Which applications were in the foreground during work sessions, and for
          how long. Reported by the SpiderHunts Monitor and counted in the
          database — no window titles, no URLs and no page addresses are recorded.
          Nothing here is classified as productive or unproductive, and none of
          it feeds the productivity score.
        </p>
      </header>

      {/* --- filters ------------------------------------------------------ */}
      <section aria-label="Filters" className="panel flex flex-wrap items-end gap-3 px-4 py-3">
        <Field label="Period" htmlFor="period">
          <Select
            id="period"
            value={rangeKey}
            onChange={(value) => setRangeKey(value as RangeKey)}
            options={PERIODS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))}
          />
        </Field>

        {rangeKey === "custom" && (
          <>
            <Field label="From" htmlFor="from">
              <input
                id="from"
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="ui-field h-9 w-[152px]"
              />
            </Field>
            <Field label="To" htmlFor="to">
              <input
                id="to"
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
                className="ui-field h-9 w-[152px]"
              />
            </Field>
          </>
        )}

        <Field label="Employee" htmlFor="agent">
          <Select
            id="agent"
            value={agentId}
            onChange={(value) => {
              setAgentId(value);
              setTimelineOpen(false);
            }}
            options={[
              { value: "all", label: "All employees" },
              ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
        </Field>

        <Field label="Application" htmlFor="application">
          <Select
            id="application"
            value={application}
            onChange={setApplication}
            options={[
              { value: "all", label: "All applications" },
              ...applications.map((name) => ({ value: name, label: name })),
            ]}
          />
        </Field>

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

      {/* --- the headline figures ----------------------------------------- */}
      <section aria-label="Totals" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Recorded"
          value={formatDuration(summary.recordedSeconds)}
          hint="Foreground time reported by the Monitor"
        />
        <Stat
          label="Tracked"
          value={formatDuration(summary.trackedSeconds)}
          hint="Time in work sessions — the portal's own record"
        />
        <Stat
          label="Coverage"
          value={summary.coveragePercentage === null ? "—" : `${summary.coveragePercentage}%`}
          hint={
            summary.coveragePercentage === null
              ? "no tracked time in this period"
              : "of tracked time has an application reported"
          }
        />
        <Stat
          label="Applications"
          value={summary.applications.toLocaleString()}
          hint={summary.applications === 1 ? "distinct label" : "distinct labels"}
        />
      </section>

      {/* --- the employee view -------------------------------------------- */}
      {employee && (
        <section className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div>
              <h2 className="text-cell font-medium text-fg">{employee.user.name}</h2>
              <p className="mt-0.5 text-meta text-fg-4">
                {employee.user.role === "ADMIN" ? "Administrator" : "Agent"} ·{" "}
                {employee.user.username}
              </p>
            </div>
            <dl className="flex flex-wrap items-center gap-5">
              <Figure label="Tracked" value={formatDuration(employee.trackedSeconds)} />
              <Figure label="Activity" value={formatActivity(employee.activityPercentage)} />
              <Figure label="In apps" value={formatDuration(employee.recordedSeconds)} />
            </dl>
          </div>

          <AppUsageBreakdown
            applications={employee.applications}
            emptyMessage="No application usage has been recorded for this employee in this period. This needs the SpiderHunts Monitor running on their workstation."
          />

          <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
            <Link
              href={`/reports/time/${employee.user.id}`}
              className="text-meta text-fg-3 underline-offset-2 hover:text-fg hover:underline"
            >
              Open their time tracking record
            </Link>
            <button
              type="button"
              onClick={() => {
                const next = !timelineOpen;
                setTimelineOpen(next);
                if (next && !timeline) void loadTimeline();
              }}
              className="ui-btn ui-btn-ghost ml-auto h-8"
            >
              {timelineOpen ? "Hide timeline" : "Show daily timeline"}
            </button>
          </div>

          {timelineOpen && (
            <div className="border-t border-line">
              {timelineError ? (
                <p className="px-5 py-6 text-center text-ui text-danger">{timelineError}</p>
              ) : timeline === null ? (
                <p className="px-5 py-6 text-center text-ui text-fg-3">Loading the timeline…</p>
              ) : timeline.entries.length === 0 ? (
                <p className="px-5 py-6 text-center text-ui text-fg-3">
                  Nothing was reported in this period.
                </p>
              ) : (
                <>
                  <ul className="flex flex-col">
                    {timeline.entries.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-center gap-4 border-b border-line px-5 py-2 last:border-b-0"
                      >
                        <span className="tnum shrink-0 font-mono text-num text-fg-2">
                          {clock(entry.startedAt)}–{clock(entry.endedAt)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-cell text-fg">
                          {entry.applicationName}
                          <span className="ml-2 font-mono text-meta text-fg-4">
                            {entry.processName}
                          </span>
                        </span>
                        <span className="tnum shrink-0 font-mono text-num text-fg-3">
                          {formatDuration(entry.durationSeconds)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {timeline.truncated && (
                    <p className="border-t border-line px-5 py-2.5 text-meta text-fg-4">
                      Showing the first {timeline.entries.length} segments of this period.
                      Narrow the range to see the rest.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      )}

      {/* --- the application table ---------------------------------------- */}
      <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">
            {agentId === "all" ? "All employees" : "Everyone, for comparison"}
          </h2>
          <p className="text-meta text-fg-4">
            share is of recorded app time · &ldquo;of tracked&rdquo; is of time on the clock
          </p>
        </div>

        <AppUsageBreakdown applications={payload.applications} />
      </section>

      <p className="text-meta leading-relaxed text-fg-4">
        Tracked time comes from work sessions — the portal&rsquo;s own record of
        when somebody was signed in and working — and is never derived from app
        usage, so an employee working without the desktop Monitor still has their
        hours counted in full and simply reports no applications. App usage is a
        separate reporting metric: it is not part of the activity percentage and
        not part of the productivity score.
      </p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-caption font-medium text-fg-3">{label}</p>
      <p className="display-num mt-1.5 text-[26px] leading-none text-fg">{value}</p>
      <p className="mt-1.5 text-meta text-fg-4">{hint}</p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="tnum mt-0.5 font-mono text-num text-fg">{value}</dd>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="field-label">
        {label}
      </label>
      {children}
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

/** `09:02`. Hours and minutes, 24-hour, matching every other tracking screen. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
