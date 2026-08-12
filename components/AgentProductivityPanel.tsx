"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown } from "lucide-react";

import { ScorePill } from "./ProductivityPanel";
import { formatDuration, RANGE_LABELS, type RangeKey } from "@/lib/performanceRules";
import {
  formatScore,
  METRIC_DEFINITIONS,
  productivityBand,
  type AgentProductivityDetail,
} from "@/lib/productivityRules";

/**
 * One agent's productivity, with the arithmetic shown. ADMIN only.
 *
 * **The breakdown is the point of this screen.** A single number nobody can
 * check is a number nobody trusts, so every component is listed with what the
 * agent did, what was expected of them, the percentage that produces and the
 * weight it carries — and the overall beneath it is those five figures weighted,
 * which a reader can verify with a calculator. That is why the component scores
 * are rounded to whole numbers before they are weighted rather than after: the
 * sum on the screen has to be the sum that was computed.
 *
 * **Where a metric could not be scored, the row says so** and shows the weight
 * it gave up, rather than showing a zero. The two are completely different facts
 * about an agent and a dashboard that renders them identically is lying about
 * one of them.
 */
const PERIODS: RangeKey[] = ["today", "yesterday", "last7", "last30", "custom"];

export default function AgentProductivityPanel({
  initialDetail,
}: {
  initialDetail: AgentProductivityDetail;
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [rangeKey, setRangeKey] = useState<RangeKey>(initialDetail.range.key as RangeKey);
  const [customFrom, setCustomFrom] = useState(initialDetail.range.from);
  const [customTo, setCustomTo] = useState(initialDetail.range.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useRef(0);
  const primed = useRef(true);
  const agentId = initialDetail.agent.id;

  const load = useCallback(async () => {
    const ticket = ++request.current;
    setBusy(true);

    const params = new URLSearchParams({ range: rangeKey });
    if (rangeKey === "custom") {
      params.set("from", customFrom);
      params.set("to", customTo);
    }

    try {
      const response = await fetch(`/api/reports/productivity/${agentId}?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as AgentProductivityDetail;
      if (ticket === request.current) {
        setDetail(next);
        setError(null);
      }
    } catch {
      if (ticket === request.current) setError("Could not load this agent.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }, [agentId, rangeKey, customFrom, customTo]);

  useEffect(() => {
    if (primed.current) {
      primed.current = false;
      return;
    }
    void load();
  }, [load]);

  const { row, config, agent } = detail;
  const score = row.productivity;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href="/reports/productivity"
            className="inline-flex items-center gap-1.5 text-meta text-fg-3 underline-offset-2 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Team productivity
          </Link>
          <h1 className="page-title mt-2">{agent.name}</h1>
          <p className="mt-1 text-meta text-fg-4">
            @{agent.username}
            {row.online && <span className="ml-2 text-success">online</span>}
            {!agent.isActive && <span className="ml-2">disabled</span>}
            {row.rank !== null && <span className="ml-2">· ranked #{row.rank} this period</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="period" className="field-label">
              Period
            </label>
            <span className="relative inline-flex items-center">
              <select
                id="period"
                value={rangeKey}
                onChange={(event) => setRangeKey(event.target.value as RangeKey)}
                className="ui-field h-9 min-w-[152px] appearance-none pr-8"
              >
                {PERIODS.map((key) => (
                  <option key={key} value={key}>
                    {RANGE_LABELS[key]}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-4"
                strokeWidth={2}
                aria-hidden="true"
              />
            </span>
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

          <p className="self-center text-meta text-fg-4" aria-live="polite">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : busy ? (
              "Loading…"
            ) : (
              `${detail.range.from} → ${detail.range.to}`
            )}
          </p>
        </div>
      </header>

      <div className={busy ? "opacity-60" : undefined}>
        {/* --- the headline ------------------------------------------------ */}
        <section className="panel flex flex-wrap items-center gap-x-10 gap-y-4 px-5 py-4">
          <div>
            <p className="eyebrow">Productivity</p>
            {/* The one place the score is drawn large. `ScorePill` sets its own
                size for a table cell, so the headline states the band tint
                itself rather than fighting it with a wrapper. */}
            <p
              className={`tnum mt-1 font-mono text-[40px] font-semibold leading-none ${
                {
                  none: "text-fg-4",
                  low: "text-danger",
                  moderate: "text-fg",
                  high: "text-success",
                }[productivityBand(score.score)]
              }`}
            >
              {formatScore(score.score)}
            </p>
            <p className="mt-1.5 text-meta text-fg-4">
              {score.workedDays === 0
                ? "Not on the clock in this period — nothing to measure against."
                : `Measured over ${score.workedDays} worked day${score.workedDays === 1 ? "" : "s"}.`}
            </p>
          </div>

          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <Split
              label="Activity"
              value={row.activityPercentage === null ? "—" : `${row.activityPercentage}%`}
              hint="Keyboard and mouse, from the Monitor"
            />
            <Split
              label="Output"
              value={formatScore(score.outputScore)}
              hint="The four work metrics, without activity"
            />
            <Split label="Tracked" value={formatDuration(row.trackedSeconds)} hint="Time in work sessions" />
            <Split
              label="Inactive"
              value={formatDuration(row.idleSeconds)}
              hint="Tracked time with no input observed"
            />
          </div>
        </section>

        {/* --- the counts -------------------------------------------------- */}
        <section aria-label="What was counted" className="mt-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Count label="Calls" value={row.calls} />
          <Count label="Leads processed" value={row.leadsProcessed} />
          <Count label="Meetings booked" value={row.meetingsBooked} />
          <Count label="Meetings completed" value={row.meetingsCompleted} />
          <Count label="Follow-up calls" value={row.followUpCalls} />
          <Count
            label="Callbacks scheduled"
            value={row.callbacksScheduled}
            hint="Reported, not scored"
          />
        </section>

        {/* --- how the score was calculated -------------------------------- */}
        <section className="panel mt-5 overflow-hidden">
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-caption font-medium text-fg-2">How this score was calculated</h2>
            <p className="mt-1 text-meta text-fg-4">
              Each metric as a percentage of its target, capped at 100%, then
              weighted. Targets are per worked day, so the expectation below is
              the daily target multiplied by {score.workedDays || 0} worked day
              {score.workedDays === 1 ? "" : "s"}.
            </p>
          </div>

          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="eyebrow px-5 py-2 text-left">
                    Metric
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-right">
                    Actual
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-right">
                    Expected
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-right">
                    Score
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-right">
                    Weight
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-right">
                    Applied
                  </th>
                </tr>
              </thead>
              <tbody>
                {score.components.map((component) => (
                  <tr key={component.key} className="border-b border-line">
                    <td className="px-5 py-3">
                      <p className="text-cell font-medium text-fg">{component.label}</p>
                      <p className="mt-0.5 text-meta text-fg-4">
                        {component.unavailableReason ?? METRIC_DEFINITIONS[component.key]}
                      </p>
                    </td>
                    <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">
                      {component.actual === null
                        ? "—"
                        : component.key === "activity"
                          ? `${component.actual}%`
                          : component.actual.toLocaleString()}
                    </td>
                    <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-3">
                      {component.expected === null
                        ? "—"
                        : component.key === "activity"
                          ? `${component.expected}%`
                          : component.expected.toLocaleString()}
                    </td>
                    <td className="tnum px-3 py-3 text-right font-mono text-num font-semibold text-fg">
                      {component.score === null ? "—" : `${component.score}%`}
                    </td>
                    <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-3">
                      {component.weight}%
                    </td>
                    <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">
                      {component.available ? `${component.appliedWeight}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-2">
                  <td className="px-5 py-3 text-cell font-semibold text-fg">Overall</td>
                  <td colSpan={2} />
                  <td className="px-3 py-3 text-right">
                    <ScorePill value={score.score} />
                  </td>
                  <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-3">100%</td>
                  <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-2">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {score.components.some((component) => !component.available) && (
            <p className="border-t border-line px-5 py-3 text-meta text-fg-4">
              A metric that could not be measured is not scored zero. Its weight
              is redistributed over the metrics that could be — the{" "}
              <strong className="font-medium text-fg-3">Applied</strong> column is
              what each one actually contributed, and those are what total 100%.
            </p>
          )}
        </section>

        <p className="mt-4 text-meta text-fg-4">
          Scored against the{" "}
          {config.isDefault ? "shipped default" : "current"} configuration —{" "}
          {config.callsTarget} calls, {config.leadsTarget} leads,{" "}
          {config.meetingsTarget} meetings and {config.followUpsTarget} follow-ups
          per worked day, against a {config.activityTarget}% activity target.
          Reports always use the configuration in force right now, so changing it
          changes this page.{" "}
          <Link
            href={`/reports/time/${agent.id}`}
            className="text-fg-3 underline underline-offset-2"
          >
            This agent&rsquo;s time and activity record
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function Split({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-1 font-mono text-[22px] font-semibold leading-none text-fg">{value}</p>
      <p className="mt-1.5 text-meta text-fg-4">{hint}</p>
    </div>
  );
}

function Count({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-1 font-mono text-[20px] font-semibold leading-none text-fg">
        {value.toLocaleString()}
      </p>
      {hint && <p className="mt-1.5 text-meta text-fg-4">{hint}</p>}
    </div>
  );
}
