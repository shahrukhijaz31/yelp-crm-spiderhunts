"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { ActivityPill } from "./TimeTrackingPanel";
import { formatDuration, RANGE_LABELS, type RangeKey } from "@/lib/performanceRules";
import {
  formatScore,
  productivityBand,
  PRODUCTIVITY_SORT_KEYS,
  PRODUCTIVITY_SORT_LABELS,
  type ProductivityReport,
  type ProductivitySortKey,
} from "@/lib/productivityRules";

/**
 * Team productivity — ADMIN only, and the screen the whole feature exists for.
 *
 * **Productivity and Activity are two columns and stay two columns.** Activity
 * is the desktop Monitor's keyboard/mouse figure, unchanged and unrenamed;
 * Productivity is the weighted score of what the agent actually produced, with
 * activity as one small component of it. They sit side by side rather than one
 * replacing the other, because they answer different questions and the second
 * is the one worth acting on.
 *
 * **Nothing is calculated here.** Every figure in the table arrives scored from
 * the server; this component formats and lays out. Filtering and sorting are
 * query parameters on one fetch, not a pass over a client-side array, so the
 * browser never holds more than the rows on screen — the response is one row per
 * agent whether the database holds a thousand leads or ten million.
 *
 * **Ranking is present and deliberately small.** It is a short list to the side,
 * not the shape of the page: the useful thing on a performance screen is where
 * an agent's time went, and a leaderboard invites reading a 6-point gap as a
 * verdict.
 */

const PERIODS: RangeKey[] = ["today", "yesterday", "last7", "last30", "custom"];

export default function ProductivityPanel({
  initialPayload,
  agents,
}: {
  initialPayload: ProductivityReport;
  agents: Array<{ id: string; name: string }>;
}) {
  const [payload, setPayload] = useState(initialPayload);
  const [rangeKey, setRangeKey] = useState<RangeKey>(initialPayload.range.key as RangeKey);
  const [customFrom, setCustomFrom] = useState(initialPayload.range.from);
  const [customTo, setCustomTo] = useState(initialPayload.range.to);
  const [agentId, setAgentId] = useState("all");
  const [minActivity, setMinActivity] = useState("");
  const [minProductivity, setMinProductivity] = useState("");
  const [maxProductivity, setMaxProductivity] = useState("");
  const [sort, setSort] = useState<ProductivitySortKey>("productivity");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useRef(0);
  // The payload the server already rendered. Skipping the first fetch means the
  // screen paints with real rows and does not immediately ask for them again.
  const primed = useRef(true);

  const load = useCallback(async () => {
    const ticket = ++request.current;
    setBusy(true);

    const params = new URLSearchParams({ range: rangeKey, sort, direction });
    if (rangeKey === "custom") {
      params.set("from", customFrom);
      params.set("to", customTo);
    }
    if (agentId !== "all") params.set("agent", agentId);
    if (minActivity !== "") params.set("minActivity", minActivity);
    if (minProductivity !== "") params.set("minProductivity", minProductivity);
    if (maxProductivity !== "") params.set("maxProductivity", maxProductivity);

    try {
      const response = await fetch(`/api/reports/productivity?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as ProductivityReport;
      if (ticket === request.current) {
        setPayload(next);
        setError(null);
      }
    } catch {
      if (ticket === request.current) setError("Could not load productivity.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }, [
    rangeKey,
    customFrom,
    customTo,
    agentId,
    minActivity,
    minProductivity,
    maxProductivity,
    sort,
    direction,
  ]);

  useEffect(() => {
    if (primed.current) {
      primed.current = false;
      return;
    }
    void load();
  }, [load]);

  const { agents: rows, totals, config, ranking } = payload;

  /** Clicking a column heading sorts by it, and clicking again reverses it. */
  const sortBy = (key: ProductivitySortKey) => {
    if (key === sort) {
      setDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }
    setSort(key);
    setDirection(key === "name" ? "asc" : "desc");
  };

  const linkFor = (userId: string) => {
    const params = new URLSearchParams({ range: rangeKey });
    if (rangeKey === "custom") {
      params.set("from", customFrom);
      params.set("to", customTo);
    }
    return `/reports/productivity/${userId}?${params}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <header>
        <h1 className="page-title">Agent productivity</h1>
        <p className="mt-2 page-intro">
          Work produced against the targets in Settings, for agents only. Every
          figure is counted in the database from lead activity, work sessions and
          the Monitor&rsquo;s activity intervals — nothing here is an estimate,
          and nothing is derived from a screenshot.
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

        <Field label="Agent" htmlFor="agent">
          <Select
            id="agent"
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: "all", label: "All agents" },
              ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
        </Field>

        <Field label="Min activity" htmlFor="minActivity">
          <input
            id="minActivity"
            type="number"
            min={0}
            max={100}
            step={5}
            value={minActivity}
            placeholder="any"
            onChange={(event) => setMinActivity(event.target.value)}
            className="ui-field h-9 w-[100px]"
          />
        </Field>

        <Field label="Productivity" htmlFor="minProductivity">
          <span className="flex items-center gap-1.5">
            <input
              id="minProductivity"
              type="number"
              min={0}
              max={100}
              step={5}
              value={minProductivity}
              placeholder="min"
              onChange={(event) => setMinProductivity(event.target.value)}
              className="ui-field h-9 w-[84px]"
            />
            <span aria-hidden="true" className="text-meta text-fg-4">
              –
            </span>
            <input
              aria-label="Maximum productivity"
              type="number"
              min={0}
              max={100}
              step={5}
              value={maxProductivity}
              placeholder="max"
              onChange={(event) => setMaxProductivity(event.target.value)}
              className="ui-field h-9 w-[84px]"
            />
          </span>
        </Field>

        <Field label="Sort by" htmlFor="sort">
          <Select
            id="sort"
            value={sort}
            onChange={(value) => setSort(value as ProductivitySortKey)}
            options={PRODUCTIVITY_SORT_KEYS.map((key) => ({
              value: key,
              label: PRODUCTIVITY_SORT_LABELS[key],
            }))}
          />
        </Field>

        <button
          type="button"
          onClick={() => setDirection((current) => (current === "desc" ? "asc" : "desc"))}
          className="ui-btn ui-btn-ghost h-9"
          title="Reverse the sort order"
        >
          {direction === "desc" ? "High to low" : "Low to high"}
        </button>

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
      <section aria-label="Team summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Team productivity"
          value={formatScore(totals.productivity)}
          hint={
            totals.unscored > 0
              ? `${totals.unscored} agent${totals.unscored === 1 ? "" : "s"} unscored — not on the clock`
              : `Mean over ${totals.agents} agent${totals.agents === 1 ? "" : "s"}`
          }
          band={productivityBand(totals.productivity)}
        />
        <Stat
          label="Team activity"
          value={totals.activityPercentage === null ? "—" : `${totals.activityPercentage}%`}
          hint="Keyboard and mouse only — one component of the score, not the score"
        />
        <Stat label="Tracked" value={formatDuration(totals.trackedSeconds)} hint="Time in work sessions" />
        <Stat
          label="Output"
          value={`${totals.calls.toLocaleString()} calls`}
          hint={`${totals.leadsProcessed.toLocaleString()} leads · ${totals.meetingsBooked.toLocaleString()} meetings · ${totals.followUps.toLocaleString()} follow-ups`}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_260px]">
        {/* --- the table -------------------------------------------------- */}
        <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h2 className="text-caption font-medium text-fg-2">Team productivity</h2>
            <p className="text-meta text-fg-4">
              {rows.length} {rows.length === 1 ? "agent" : "agents"}
            </p>
          </div>

          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[880px]">
              <thead>
                <tr className="border-b border-line">
                  <SortHead
                    align="left"
                    active={sort === "name"}
                    direction={direction}
                    onClick={() => sortBy("name")}
                  >
                    Agent
                  </SortHead>
                  <SortHead active={sort === "tracked"} direction={direction} onClick={() => sortBy("tracked")}>
                    Hours
                  </SortHead>
                  <SortHead active={sort === "activity"} direction={direction} onClick={() => sortBy("activity")}>
                    Activity
                  </SortHead>
                  <SortHead active={sort === "calls"} direction={direction} onClick={() => sortBy("calls")}>
                    Calls
                  </SortHead>
                  <SortHead active={sort === "leads"} direction={direction} onClick={() => sortBy("leads")}>
                    Leads
                  </SortHead>
                  <SortHead active={sort === "meetings"} direction={direction} onClick={() => sortBy("meetings")}>
                    Meetings
                  </SortHead>
                  <th scope="col" className="eyebrow px-3 py-2 text-right">
                    Follow-ups
                  </th>
                  <SortHead
                    active={sort === "productivity"}
                    direction={direction}
                    onClick={() => sortBy("productivity")}
                  >
                    Productivity
                  </SortHead>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.userId} className="border-b border-line last:border-b-0">
                    <td className="px-5 py-3">
                      <Link
                        href={linkFor(row.userId)}
                        className="text-cell font-medium text-fg underline-offset-2 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.online && <span className="ml-2 text-meta text-success">online</span>}
                      {!row.isActive && <span className="ml-2 text-meta text-fg-4">disabled</span>}
                    </td>
                    <Cell>{formatDuration(row.trackedSeconds)}</Cell>
                    <td className="px-3 py-3 text-right">
                      <ActivityPill value={row.activityPercentage} />
                    </td>
                    <Cell>{row.calls.toLocaleString()}</Cell>
                    <Cell>{row.leadsProcessed.toLocaleString()}</Cell>
                    <Cell>{row.meetingsBooked.toLocaleString()}</Cell>
                    <Cell>{row.followUps.toLocaleString()}</Cell>
                    <td className="px-3 py-3 text-right">
                      <ScorePill value={row.productivity.score} />
                      {row.productivity.score === null && (
                        <span className="ml-2 text-meta text-fg-4">no tracked days</span>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-8 text-center text-ui text-fg-3">
                      No agents match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* --- ranking ------------------------------------------------------ */}
        <aside className="flex flex-col gap-5">
          <section className="panel overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-caption font-medium text-fg-2">Ranking</h2>
              <p className="mt-1 text-meta text-fg-4">
                Every scored agent in this period, before the filters above.
              </p>
            </div>
            <ol className="flex flex-col">
              {ranking.map((entry, index) => (
                <li
                  key={entry.userId}
                  className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0"
                >
                  <span className="tnum w-4 shrink-0 text-right font-mono text-meta text-fg-4">
                    {index + 1}
                  </span>
                  <Link
                    href={linkFor(entry.userId)}
                    className="min-w-0 flex-1 truncate text-ui text-fg-2 underline-offset-2 hover:underline"
                  >
                    {entry.name}
                  </Link>
                  <ScorePill value={entry.score} />
                </li>
              ))}
              {ranking.length === 0 && (
                <li className="px-4 py-6 text-center text-ui text-fg-3">
                  No agent could be scored in this period.
                </li>
              )}
            </ol>
          </section>

          <section className="panel px-4 py-3">
            <h2 className="text-caption font-medium text-fg-2">Current weights</h2>
            <dl className="mt-2 flex flex-col gap-1">
              <Weight label="Calls" target={`${config.callsTarget}/day`} weight={config.callsWeight} />
              <Weight label="Leads processed" target={`${config.leadsTarget}/day`} weight={config.leadsWeight} />
              <Weight label="Meetings booked" target={`${config.meetingsTarget}/day`} weight={config.meetingsWeight} />
              <Weight label="Activity" target={`${config.activityTarget}%`} weight={config.activityWeight} />
              <Weight label="Follow-ups" target={`${config.followUpsTarget}/day`} weight={config.followUpsWeight} />
            </dl>
            <p className="mt-3 text-meta text-fg-4">
              {config.isDefault
                ? "The shipped defaults — nobody has changed these yet."
                : `Last changed by ${config.updatedByName ?? "an administrator"}.`}{" "}
              <Link href="/settings" className="text-fg-3 underline underline-offset-2">
                Change them in Settings
              </Link>
              . Reports always use the configuration in force right now, including
              reports about earlier periods.
            </p>
          </section>
        </aside>
      </div>

      <p className="text-meta text-fg-4">
        <strong className="font-medium text-fg-3">Productivity</strong> is the
        weighted score of work produced against the targets above, each metric
        capped at 100% of its target and scaled by the days the agent was on the
        clock.{" "}
        <strong className="font-medium text-fg-3">Activity</strong> is the
        Monitor&rsquo;s keyboard and mouse figure — one component of the score,
        carrying the smallest weight, and never a measure of productivity on its
        own. An agent with no activity data is not scored zero for it: the weight
        is redistributed over the metrics that could be measured. Administrators
        are not scored and never appear here.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A productivity score, banded.
 *
 * Exported because the agent detail screen shows the same figure and it must
 * look and round identically in both places — one definition of "what 87.4%
 * looks like", not two.
 */
export function ScorePill({ value }: { value: number | null }) {
  const tint = {
    none: "text-fg-4",
    low: "text-danger",
    moderate: "text-fg",
    high: "text-success",
  }[productivityBand(value)];

  return <span className={`tnum font-mono text-num font-semibold ${tint}`}>{formatScore(value)}</span>;
}

function Stat({
  label,
  value,
  hint,
  band,
}: {
  label: string;
  value: string;
  hint: string;
  band?: "none" | "low" | "moderate" | "high";
}) {
  const tint = band
    ? { none: "text-fg-3", low: "text-danger", moderate: "text-fg", high: "text-success" }[band]
    : "text-fg";

  return (
    <div className="panel px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={`tnum mt-1 font-mono text-[22px] font-semibold leading-none ${tint}`}>{value}</p>
      <p className="mt-1.5 text-meta text-fg-4">{hint}</p>
    </div>
  );
}

function Weight({ label, target, weight }: { label: string; target: string; weight: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ui text-fg-3">{label}</dt>
      <dd className="tnum shrink-0 font-mono text-num text-fg-2">
        {target} <span className="text-fg-4">· {weight}%</span>
      </dd>
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

/**
 * A column heading that sorts.
 *
 * `aria-sort` is on the cell rather than the button so a screen reader announces
 * the column's state when it reaches the header, which is where the information
 * is useful — not only when the control inside it is focused.
 */
function SortHead({
  children,
  active,
  direction,
  onClick,
  align = "right",
}: {
  children: React.ReactNode;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={`eyebrow px-3 py-2 ${align === "left" ? "pl-5 text-left" : "text-right"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 rounded outline-none hover:text-fg-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)] ${
          active ? "text-fg-2" : ""
        }`}
      >
        {children}
        {active && (
          <ChevronDown
            className={`h-3 w-3 ${direction === "asc" ? "rotate-180" : ""}`}
            strokeWidth={2.5}
            aria-hidden="true"
          />
        )}
      </button>
    </th>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">{children}</td>;
}
