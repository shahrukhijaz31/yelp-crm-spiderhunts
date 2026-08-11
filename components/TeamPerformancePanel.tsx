"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarCheck,
  ChevronDown,
  PhoneOutgoing,
  Timer,
  Users2,
} from "lucide-react";

import CountUp from "./CountUp";
import { useSpotlight } from "./useSpotlight";
import type { Role } from "@/lib/access";
import {
  contactRate,
  conversionRate,
  formatDuration,
  formatWorkClock,
  leadsPerHour,
  RANGE_KEYS,
  RANGE_LABELS,
  type AgentPerformance,
  type AgentWorkTime,
  type DateRange,
  type PerformanceReport,
  type RangeKey,
} from "@/lib/performanceRules";

/**
 * Team performance — the administrator's report.
 *
 * **The security note first, because it is the important one.** Everything on
 * this screen arrives from `GET /api/reports/team`, which is behind
 * `apiAdmin()` and answers 403 to an agent holding a perfectly valid session.
 * Nothing here — not the agent picker, not the date filter, not the initial
 * render — is what keeps an agent out; this component simply is not rendered
 * for them, because the page above it refuses first. If every line of this file
 * were pasted into an agent's browser it would fetch nothing but a 403.
 *
 * **The layout.** Four KPI cards, one table, two charts, in that order, and
 * deliberately not eleven cards. The brief lists ten possible metrics; putting
 * each in its own tile produces a wall of numbers where nothing is more
 * important than anything else and none of it gets read. So the four figures
 * that describe the team's output are cards, the per-agent detail is a table
 * (which is what a per-agent comparison actually wants — aligned columns you
 * can run an eye down), and the rates are given room at the bottom where they
 * can carry the sentence of context each of them needs.
 *
 * **The filters drive one fetch.** Changing a preset or an agent re-queries the
 * server; nothing is filtered in the browser, because the browser never has
 * more than the aggregate. That is the same property the worklist has and for
 * the same reason: the response is one row per agent whether the tables behind
 * it hold a thousand activity rows or ten million.
 */
export default function TeamPerformancePanel({
  initialReport,
  agents,
}: {
  initialReport: PerformanceReport;
  /** Every account, for the picker. Names only — this is a filter, not a list. */
  agents: Array<{ id: string; name: string; role: Role }>;
}) {
  const [report, setReport] = useState(initialReport);
  const [rangeKey, setRangeKey] = useState<RangeKey>(initialReport.range.key);
  const [customFrom, setCustomFrom] = useState(initialReport.range.fromDay);
  const [customTo, setCustomTo] = useState(initialReport.range.toDay);
  const [agentId, setAgentId] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identifies the request in flight, so a slow "last 30 days" cannot land on
  // top of the "today" an admin asked for afterwards. The same guard the
  // worklist uses, for the same reason.
  const requestId = useRef(0);

  const load = useCallback(
    async (key: RangeKey, from: string, to: string, agent: string) => {
      // The first render already holds exactly this report — the server built
      // it. Re-fetching it on mount would be a wasted round trip and a visible
      // flicker on a screen that was already correct.
      const id = (requestId.current += 1);
      setBusy(true);
      setError(null);

      const params = new URLSearchParams({ range: key, agent });
      if (key === "custom") {
        params.set("from", from);
        params.set("to", to);
      }

      try {
        const response = await fetch(`/api/reports/team?${params}`, {
          credentials: "same-origin",
        });
        if (id !== requestId.current) return;

        if (!response.ok) {
          setError(
            response.status === 403
              ? "This report is for administrators only."
              : "Could not load the report. Try again.",
          );
          return;
        }

        const payload = (await response.json()) as { report: PerformanceReport };
        if (id !== requestId.current) return;
        setReport(payload.report);
      } catch {
        if (id === requestId.current) setError("Could not reach the server.");
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    },
    [],
  );

  // Skips the first run: the server rendered this exact report.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void load(rangeKey, customFrom, customTo, agentId);
  }, [load, rangeKey, customFrom, customTo, agentId]);

  const { totals, agents: rows, range, daily } = report;

  // Busiest agent first. A report read top-to-bottom should open with the
  // person who did the most, and alphabetical order says nothing at all.
  const ranked = useMemo(
    () => [...rows].sort((a, b) => b.leadsWorked - a.leadsWorked || a.name.localeCompare(b.name)),
    [rows],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">Team performance</h1>
          <p className="mt-2 page-intro">
            What the team actually did, {rangeCaption(range)}. Every figure is
            counted from work agents saved — there are no estimates here.
          </p>
        </div>
      </header>

      {/* --- filters ----------------------------------------------------- */}
      <section
        aria-label="Report filters"
        className="panel flex flex-wrap items-end gap-3 px-4 py-3"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="range" className="field-label">
            Period
          </label>
          <Select
            id="range"
            value={rangeKey}
            onChange={(value) => setRangeKey(value as RangeKey)}
            options={RANGE_KEYS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))}
          />
        </div>

        {rangeKey === "custom" && (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="from" className="field-label">
                From
              </label>
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
              <label htmlFor="to" className="field-label">
                To
              </label>
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

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="agent" className="field-label">
            Agent
          </label>
          <Select
            id="agent"
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: "all", label: "All agents" },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.role === "ADMIN" ? `${agent.name} (admin)` : agent.name,
              })),
            ]}
          />
        </div>

        <p className="ml-auto self-center text-meta text-fg-4" aria-live="polite">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : busy ? (
            "Loading…"
          ) : (
            `${range.fromDay} → ${range.toDay}`
          )}
        </p>
      </section>

      {/* --- the four headline figures ----------------------------------- */}
      {/* Divided segments of one panel rather than four bordered cards, the
          same object the worklist's headline strip is. Four separate cards
          would say these are four unrelated widgets; they are one summary of
          one team over one window. */}
      <section
        aria-label="Team totals"
        className={`panel grid grid-cols-1 gap-px overflow-hidden bg-line transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-4 ${
          busy ? "opacity-60" : ""
        }`}
      >
        <Kpi
          icon={Users2}
          value={totals.leadsWorked}
          label="Leads worked"
          hint="distinct leads with an outcome saved"
        />
        <Kpi
          icon={PhoneOutgoing}
          value={totals.calls}
          label="Calls"
          hint={`${totals.contacts.toLocaleString()} answered`}
        />
        <Kpi
          icon={CalendarCheck}
          value={totals.meetingsBooked}
          label="Meetings booked"
          hint={`${totals.meetingsCompleted} completed`}
        />
        <Kpi
          icon={Timer}
          text={formatDuration(totals.activeSeconds)}
          label="Active time"
          hint={`${formatDuration(averageActive(ranked))} per agent on average`}
        />
      </section>

      {/* --- per agent --------------------------------------------------- */}
      <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Agent performance</h2>
          <p className="text-meta text-fg-4">
            {ranked.length} {ranked.length === 1 ? "account" : "accounts"}
          </p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-5 py-2 text-left">Agent</th>
                <NumericHead>Leads</NumericHead>
                <NumericHead>Calls</NumericHead>
                <NumericHead>Answered</NumericHead>
                <NumericHead>Callbacks</NumericHead>
                <NumericHead>Meetings</NumericHead>
                <NumericHead>Interested</NumericHead>
                <NumericHead>Active time</NumericHead>
                <NumericHead>Leads / hr</NumericHead>
              </tr>
            </thead>
            <tbody>
              {ranked.map((agent) => (
                <AgentRow key={agent.userId} agent={agent} peak={ranked[0]?.leadsWorked ?? 0} />
              ))}
              {ranked.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-8 text-center text-ui text-fg-3">
                    No accounts to report on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* --- work time --------------------------------------------------- */}
      {/* Its own section, below the range-driven table and deliberately not
          part of it. These three windows are fixed: "how long has Ahmed worked
          today" is a question with one answer, and routing it through a filter
          that might say "yesterday" would make the column headings lie. */}
      <WorkTimeTable rows={report.workTime} busy={busy} />

      {/* --- shape of the period ----------------------------------------- */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <section className={`panel px-5 py-4 lg:col-span-2 ${busy ? "opacity-60" : ""}`}>
          <h2 className="text-caption font-medium text-fg-2">Activity over the period</h2>
          <ActivityChart days={daily} />
        </section>

        <section className={`panel flex flex-col gap-4 px-5 py-4 ${busy ? "opacity-60" : ""}`}>
          <h2 className="text-caption font-medium text-fg-2">Conversion</h2>

          <div>
            <p className="display-num text-[34px] leading-none text-fg">
              {formatRate(conversionRate(totals))}
            </p>
            <p className="mt-1.5 text-meta text-fg-3">
              of leads worked ended in “Interested” — {totals.interested.toLocaleString()} of{" "}
              {totals.leadsWorked.toLocaleString()}.
            </p>
          </div>

          <div aria-hidden="true" className="h-px bg-line" />

          <Rate
            label="Answer rate"
            value={contactRate(totals)}
            hint={`${totals.contacts.toLocaleString()} of ${totals.calls.toLocaleString()} calls reached a person`}
          />
          <Rate
            label="Decided"
            value={
              totals.leadsWorked === 0 ? null : (totals.decided / totals.leadsWorked) * 100
            }
            hint={`${totals.decided.toLocaleString()} said yes or no`}
          />
          <Rate
            label="Leads per hour"
            value={null}
            text={formatPerHour(leadsPerHour(totals))}
            hint="across all agents' active time"
          />
        </section>
      </div>
    </div>
  );
}

/**
 * Work time per agent: today, this week, this month, and the shift running now.
 *
 * The live column is the reason this is a client component rather than a static
 * table. The server sends `currentSessionStartedAt` — an instant — and the
 * clock is counted forward from it here, so an admin watching this screen sees
 * the same number the agent sees in their own top bar rather than a figure
 * frozen at whenever the page was loaded. Sending a duration instead would be
 * stale before it rendered.
 *
 * `Today` includes the running session, exactly as the agent's own total does.
 * The two are the same query over the same rows, which is what lets an admin
 * and an agent compare notes and agree.
 */
function WorkTimeTable({ rows, busy }: { rows: AgentWorkTime[]; busy: boolean }) {
  // One tick a minute, not one a second: this table shows hours and minutes, so
  // a per-second interval would re-render nine rows sixty times to change
  // nothing. `null` until the first tick keeps the server render and the first
  // client paint identical.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const ranked = useMemo(
    () => [...rows].sort((a, b) => b.todaySeconds - a.todaySeconds || a.name.localeCompare(b.name)),
    [rows],
  );

  return (
    <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="text-caption font-medium text-fg-2">Work time</h2>
        <p className="text-meta text-fg-4">
          From signed-in sessions. Fixed windows — not affected by the filters above.
        </p>
      </div>

      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="eyebrow px-5 py-2 text-left">Agent</th>
              <NumericHead>Current session</NumericHead>
              <NumericHead>Today</NumericHead>
              <NumericHead>This week</NumericHead>
              <NumericHead>This month</NumericHead>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => {
              const startedMs = row.currentSessionStartedAt
                ? new Date(row.currentSessionStartedAt).getTime()
                : null;
              const currentSeconds =
                startedMs === null || nowMs === null
                  ? null
                  : Math.max(0, Math.floor((nowMs - startedMs) / 1000));

              // The server's `todaySeconds` stopped moving when the response was
              // built and already contains the running session up to that
              // instant. For somebody still working, add only the seconds
              // *since* `asOf` — adding the session itself would count it
              // twice, which is precisely the bug this feature had.
              const sinceAsOf =
                nowMs === null || row.currentSessionStartedAt === null
                  ? 0
                  : Math.max(0, Math.floor((nowMs - new Date(row.asOf).getTime()) / 1000));

              return (
                <tr
                  key={row.userId}
                  className="border-b border-line/60 transition-colors last:border-0 hover:bg-hover/50"
                >
                  <td className="px-5 py-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden="true" className="relative flex h-1.5 w-1.5 shrink-0">
                        {startedMs !== null && (
                          <span className="pulse-ring absolute inset-0 rounded-full bg-success" />
                        )}
                        <span
                          className={`relative h-1.5 w-1.5 rounded-full ${
                            startedMs !== null ? "bg-success" : "bg-fg-4/40"
                          }`}
                        />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-ui font-medium text-fg">
                          {row.name}
                        </span>
                        <span className="block truncate text-meta text-fg-4">
                          {row.role === "ADMIN" ? "Administrator" : "Agent"}
                          {startedMs !== null ? " · working now" : ""}
                        </span>
                      </span>
                    </span>
                  </td>
                  <Numeric>
                    {currentSeconds === null ? (
                      <span className="text-fg-4">—</span>
                    ) : (
                      <span className="text-fg">{formatWorkClock(currentSeconds)}</span>
                    )}
                  </Numeric>
                  <Numeric>
                    <span className="font-semibold text-fg">
                      {formatWorkClock(row.todaySeconds + sinceAsOf)}
                    </span>
                  </Numeric>
                  <Numeric>{formatWorkClock(row.weekSeconds)}</Numeric>
                  <Numeric>{formatWorkClock(row.monthSeconds)}</Numeric>
                </tr>
              );
            })}
            {ranked.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-ui text-fg-3">
                  No accounts to report on.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * One agent's row, with a bar drawn behind the leads figure.
 *
 * The bar is scaled to the busiest agent in the window rather than to a fixed
 * target: the question this table answers is "how does the team compare", and a
 * bar against an absolute goal would show four identical stubs on a quiet day
 * and tell nobody anything.
 */
function AgentRow({ agent, peak }: { agent: AgentPerformance; peak: number }) {
  const share = peak === 0 ? 0 : (agent.leadsWorked / peak) * 100;

  return (
    <tr className="border-b border-line/60 transition-colors last:border-0 hover:bg-hover/50">
      <td className="px-5 py-3">
        <span className="flex min-w-0 items-center gap-2.5">
          {/* Online is a fact about right now, not about the window being
              reported on, so it is a quiet dot rather than a column. */}
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              agent.online ? "bg-success" : "bg-fg-4/40"
            }`}
          />
          <span className="min-w-0">
            <span className="block truncate text-ui font-medium text-fg">{agent.name}</span>
            <span className="block truncate text-meta text-fg-4">
              {agent.role === "ADMIN" ? "Administrator" : "Agent"}
              {agent.isActive ? "" : " · disabled"}
              {agent.online ? " · signed in" : ""}
            </span>
          </span>
        </span>
      </td>

      <td className="px-3 py-3">
        <span className="flex items-center justify-end gap-2.5">
          <span
            aria-hidden="true"
            className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-hover xl:block"
          >
            <span
              className="block h-full rounded-full bg-accent/70 transition-[width] duration-500 ease-out"
              style={{ width: `${share}%` }}
            />
          </span>
          <span className="tnum font-mono text-num font-semibold text-fg">
            {agent.leadsWorked.toLocaleString()}
          </span>
        </span>
      </td>

      <Numeric>{agent.calls.toLocaleString()}</Numeric>
      <Numeric>{agent.contacts.toLocaleString()}</Numeric>
      <Numeric>{agent.callbacks.toLocaleString()}</Numeric>
      <Numeric>{agent.meetingsBooked.toLocaleString()}</Numeric>
      <Numeric>{agent.interested.toLocaleString()}</Numeric>
      <Numeric>{agent.activeSeconds === 0 ? "—" : formatDuration(agent.activeSeconds)}</Numeric>
      <Numeric>{formatPerHour(leadsPerHour(agent))}</Numeric>
    </tr>
  );
}

/**
 * Calls and meetings, day by day.
 *
 * Two series in one frame rather than two charts: meetings are a *subset* of
 * the day's outcome and are read against the calls that produced them, which is
 * a comparison a second chart underneath would make impossible. Meetings are
 * drawn as a narrower bar in front of the calls bar rather than stacked, so
 * neither figure has to be read off a moving baseline.
 *
 * Inline SVG-free — plain boxes. There is nothing here a chart library would do
 * better at this size, and a dependency that ships a rendering engine to draw
 * thirty rectangles is not one worth having.
 */
function ActivityChart({ days }: { days: PerformanceReport["daily"] }) {
  const peak = Math.max(1, ...days.map((day) => day.calls));
  // Past a fortnight the labels collide, so every other one is dropped. The
  // bars all stay — it is the axis that is crowded, not the data.
  const labelEvery = days.length > 14 ? Math.ceil(days.length / 10) : 1;

  return (
    <>
      <div className="mt-4 flex items-end gap-[3px]" style={{ height: 132 }}>
        {days.map((day, index) => (
          <div key={day.day} className="group flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="relative flex h-[104px] w-full items-end justify-center">
              <span
                title={`${day.day}: ${day.calls} calls, ${day.leadsWorked} leads worked, ${day.meetings} meetings`}
                className="w-full rounded-t-[3px] bg-accent/55 transition-colors group-hover:bg-accent/80"
                style={{ height: `${Math.max(2, (day.calls / peak) * 100)}%` }}
              />
              {day.meetings > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 w-1/2 rounded-t-[2px] bg-st-green"
                  style={{ height: `${Math.max(2, (day.meetings / peak) * 100)}%` }}
                />
              )}
            </div>
            <span className="truncate text-[10px] leading-none text-fg-4">
              {index % labelEvery === 0 ? shortDay(day.day) : " "}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 flex items-center gap-4 text-meta text-fg-4">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-accent/55" />
          Calls
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-st-green" />
          Meetings booked
        </span>
      </p>
    </>
  );
}

function Kpi({
  icon: Icon,
  value,
  text,
  label,
  hint,
}: {
  icon: React.ElementType;
  value?: number;
  text?: string;
  label: string;
  hint: string;
}) {
  const spotlight = useSpotlight<HTMLDivElement>();

  return (
    <div {...spotlight} className="spotlight group relative isolate bg-surface px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption font-medium text-fg-3">{label}</p>
          <p className="display-num mt-1.5 text-[28px] leading-none text-fg">
            {text ?? <CountUp value={value ?? 0} />}
          </p>
          <p className="mt-1.5 truncate text-meta text-fg-4">{hint}</p>
        </div>
        <Icon
          className="h-4 w-4 shrink-0 text-fg-4 transition-transform duration-300 group-hover:-translate-y-0.5"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function Rate({
  label,
  value,
  text,
  hint,
}: {
  label: string;
  value: number | null;
  text?: string;
  hint: string;
}) {
  return (
    <div>
      <p className="flex items-baseline justify-between gap-3">
        <span className="text-caption text-fg-2">{label}</span>
        <span className="tnum font-mono text-num font-semibold text-fg">
          {text ?? formatRate(value)}
        </span>
      </p>
      <p className="mt-1 text-meta text-fg-4">{hint}</p>
    </div>
  );
}

/**
 * A native `<select>`, styled.
 *
 * Deliberately not a custom listbox. The app already hand-rolls one menu
 * (`UserMenu`) and one status picker, and neither of them had to work inside a
 * filter bar on a phone — where the platform control is better than anything
 * that would be built here, and comes with keyboard and screen-reader behaviour
 * for free.
 */
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
        className="ui-field h-9 min-w-[168px] appearance-none pr-8"
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

function NumericHead({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="eyebrow px-3 py-2 text-right">
      {children}
    </th>
  );
}

function Numeric({ children }: { children: React.ReactNode }) {
  return (
    <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">{children}</td>
  );
}

/** Average across the agents who actually worked, not across every account. */
function averageActive(agents: AgentPerformance[]): number {
  const working = agents.filter((agent) => agent.activeSeconds > 0);
  if (working.length === 0) return 0;
  return Math.round(
    working.reduce((total, agent) => total + agent.activeSeconds, 0) / working.length,
  );
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatPerHour(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

/** `2026-08-10` -> `10 Aug`, the axis label. */
function shortDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function rangeCaption(range: DateRange): string {
  return range.key === "custom"
    ? `${range.fromDay} to ${range.toDay}`
    : RANGE_LABELS[range.key].toLowerCase();
}
