"use client";

import Breakdown from "./Breakdown";
import { useLeads } from "./LeadsProvider";
import { CALL_STATUS_DOTS, CALL_STATUS_SHORT_LABELS, isCalled } from "@/lib/types";

/**
 * The Reports view. Everything the old stat card was trying to say at once,
 * given room to actually say it — and taken off the worklist, where an agent
 * glancing up from a call only needs three numbers.
 */
export default function ReportsPanel() {
  const { stats, leads, today } = useLeads();

  const outcomes = stats.byStatus.interested + stats.byStatus.not_interested;
  const reachRate = stats.total === 0 ? 0 : Math.round((stats.called / stats.total) * 100);
  const interestRate = outcomes === 0 ? 0 : Math.round((stats.byStatus.interested / outcomes) * 100);
  const withWebsite = leads.filter((lead) => Boolean(lead.website)).length;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header>
        <h1 className="page-title">Summary</h1>
        <p className="mt-2 page-intro">
          Snapshot of the current list, {longDate(today)}.
        </p>
      </header>

      {/* The same divided strip as the worklist's headline, so the two
          screens' summaries are one component wearing different numbers
          rather than two takes on the idea of a stat card. Hairlines are 1px
          gaps showing the panel colour through — correct however the grid
          wraps, which `divide-x` is not. */}
      <section className="panel grid grid-cols-1 gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Card value={`${reachRate}%`} label="List worked" hint={`${stats.called} of ${stats.total} leads`} />
        <Card
          value={`${interestRate}%`}
          label="Interest rate"
          hint={`${stats.byStatus.interested} interested of ${outcomes} decided`}
          live={interestRate > 0}
        />
        <Card
          value={withWebsite}
          label="Have a website"
          hint={`${stats.missingWebsite} without one`}
        />
        <Card
          value={stats.callbackDueToday + stats.callbackOverdue}
          label="Callbacks outstanding"
          hint={`${stats.callbackOverdue} already overdue`}
          live={stats.callbackOverdue > 0}
        />
      </section>

      <section className="panel px-5 py-4">
        <Breakdown stats={stats} size="full" />
      </section>

      <section className="panel px-5 py-4">
        <h2 className="text-caption font-medium text-fg-2">Outcome detail</h2>
        <table className="mt-4 w-full">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="eyebrow pb-2 text-left">Status</th>
              <th scope="col" className="eyebrow pb-2 text-right">Leads</th>
              <th scope="col" className="eyebrow pb-2 text-right">Share of list</th>
              <th scope="col" className="eyebrow pb-2 text-right">Share of worked</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(stats.byStatus) as Array<keyof typeof stats.byStatus>).map(
              (status) => {
                const count = stats.byStatus[status];
                const ofList = stats.total === 0 ? 0 : (count / stats.total) * 100;
                const ofWorked =
                  !isCalled(status) || stats.called === 0
                    ? null
                    : (count / stats.called) * 100;

                return (
                  <tr key={status} className="border-b border-line/60 last:border-0">
                    <td className="py-2.5">
                      <span className="flex items-center gap-2.5 text-ui text-fg-2">
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full ${CALL_STATUS_DOTS[status]}`}
                        />
                        {CALL_STATUS_SHORT_LABELS[status]}
                      </span>
                    </td>
                    <td className="tnum py-3 text-right font-mono text-num font-semibold text-fg">
                      {count}
                    </td>
                    <td className="tnum py-3 text-right font-mono text-num text-fg-3">
                      {ofList.toFixed(0)}%
                    </td>
                    <td className="tnum py-3 text-right font-mono text-num text-fg-3">
                      {ofWorked === null ? "—" : `${ofWorked.toFixed(0)}%`}
                    </td>
                  </tr>
                );
              },
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** `2026-08-04` -> `Tuesday, 4 August`. */
function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function Card({
  value,
  label,
  hint,
  live,
}: {
  value: string | number;
  label: string;
  hint: string;
  live?: boolean;
}) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <p className="text-caption font-medium text-fg-3">{label}</p>
      <p
        className={`display-num mt-1.5 text-[26px] leading-none ${live ? "text-accent" : "text-fg"}`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-meta text-fg-4">{hint}</p>
    </div>
  );
}
