"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, Timer, UserCheck, Users2 } from "lucide-react";

import CountUp from "./CountUp";
import { ActivityPill } from "./TimeTrackingPanel";
import { useSpotlight } from "./useSpotlight";
import { type EmployeeTimeRow, type TeamTimePayload } from "@/lib/activityRules";
import { formatDuration } from "@/lib/performanceRules";

/**
 * Time tracking — the administrator's live dashboard.
 *
 * **The security note first.** Everything here arrives from
 * `GET /api/reports/time`, which is behind `apiAdmin()` and answers 403 to an
 * agent holding a perfectly valid session. Nothing in this component keeps an
 * agent out; the page above it refuses first, and the endpoint refuses again. If
 * every line of this file were pasted into an agent's browser it would fetch
 * nothing but a 403.
 *
 * **Nothing on this screen is invented.** Every figure is counted in Postgres
 * from work sessions, activity intervals and screenshots. An employee with no
 * activity data shows an em dash and the words "no data", never 0% — reporting
 * an agent whose Monitor is not installed as 0% active would be the single most
 * misleading thing this screen could do.
 *
 * **Online and Working are two columns because they are two facts.** Online
 * means the portal has an open work session — they are on the clock. Working
 * means input has been seen inside the idle threshold. Somebody reading on
 * screen is online and not working, and that is a normal state rather than an
 * exception. Collapsing them into one badge would quietly turn "the desktop app
 * is not running" into "this person is not working".
 *
 * It refreshes on a timer because it is a *live* board — an administrator leaves
 * it open — and the refresh is one bounded request returning one row per
 * employee.
 */

/** How often the board re-reads. A minute, matching the heartbeat's resolution. */
const REFRESH_MS = 60_000;

export default function TimeDashboardPanel({
  initialPayload,
}: {
  initialPayload: TeamTimePayload;
}) {
  const [payload, setPayload] = useState(initialPayload);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The in-flight request, so a refresh that lands after a newer one cannot
  // overwrite it — the same guard the other panels use.
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++request.current;
    setBusy(true);

    try {
      const response = await fetch("/api/reports/time", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as TeamTimePayload;
      if (ticket === request.current) {
        setPayload(next);
        setError(null);
      }
    } catch {
      if (ticket === request.current) setError("Could not refresh. Retrying shortly.");
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const { summary, employees, policy } = payload;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Time tracking</h1>
          <p className="mt-2 page-intro">
            Who is on the clock, how long they have worked and how much input has
            been observed. Activity counts keyboard and mouse events only — it is
            not a measure of productivity, and a long call reads as a quiet
            minute on it.
          </p>
        </div>

        <p className="text-meta text-fg-4" aria-live="polite">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : busy ? (
            "Refreshing…"
          ) : (
            `Updated ${clock(summary.asOf)}`
          )}
        </p>
      </header>

      {/* --- the headline figures ---------------------------------------- */}
      <section
        aria-label="Team totals"
        className={`panel grid grid-cols-2 gap-px overflow-hidden bg-line transition-opacity duration-200 lg:grid-cols-6 ${busy ? "opacity-60" : ""}`}
      >
        <Kpi icon={Users2} value={summary.totalEmployees} label="Employees" hint="accounts in the portal" />
        <Kpi
          icon={UserCheck}
          value={summary.currentlyWorking}
          label="Working"
          hint="input in the last few minutes"
        />
        <Kpi
          icon={Timer}
          value={summary.currentlyInactive}
          label="Inactive"
          hint="on the clock, no recent input"
        />
        <Kpi
          icon={Timer}
          text={formatDuration(summary.todaySeconds)}
          label="Tracked today"
          hint="everyone, from work sessions"
        />
        <Kpi
          icon={Timer}
          text={formatDuration(summary.weekSeconds)}
          label="This week"
          hint="last 7 days including today"
        />
        <Kpi
          icon={Activity}
          text={summary.averageActivityPercentage === null ? "—" : `${summary.averageActivityPercentage}%`}
          label="Average activity"
          hint={
            summary.averageActivityPercentage === null
              ? "no activity reported today"
              : "weighted across today"
          }
        />
      </section>

      {/* --- the employee table ------------------------------------------ */}
      <section className={`panel overflow-hidden ${busy ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Employees</h2>
          <p className="text-meta text-fg-4">
            inactive after {Math.round(policy.idleThresholdSeconds / 60)} min without input
          </p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[920px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-5 py-2 text-left">Employee</th>
                <th scope="col" className="eyebrow px-3 py-2 text-left">State</th>
                <Head>Today</Head>
                <Head>This week</Head>
                <Head>Activity</Head>
                <th scope="col" className="eyebrow px-3 py-2 text-right">Last input</th>
                <th scope="col" className="eyebrow px-3 py-2 text-left">Current session</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <EmployeeRow key={employee.userId} employee={employee} asOf={summary.asOf} />
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-ui text-fg-3">
                    No accounts to report on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-meta text-fg-4">
        Tracked time comes from work sessions — the portal&rsquo;s own record of
        when somebody was signed in and working. Activity describes what happened
        inside that time and is never used to compute it, so an employee working
        without the desktop Monitor still has their hours counted in full.
      </p>
    </div>
  );
}

function EmployeeRow({ employee, asOf }: { employee: EmployeeTimeRow; asOf: string }) {
  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="px-5 py-3">
        {/* The name is the way in to the detail screen. A whole-row link would
            be nicer to hit and impossible to select text in, which is the wrong
            trade on a table people read numbers off. */}
        <Link
          href={`/reports/time/${employee.userId}`}
          className="text-cell font-medium text-fg underline-offset-2 hover:underline"
        >
          {employee.name}
        </Link>
        <span className="ml-2 text-meta text-fg-4">
          {employee.role === "ADMIN" ? "admin" : employee.username}
        </span>
        {!employee.isActive && (
          <span className="ml-2 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-3">
            Disabled
          </span>
        )}
      </td>

      <td className="px-3 py-3">
        <StateBadge employee={employee} />
      </td>

      <Cell>{formatDuration(employee.todaySeconds)}</Cell>
      <Cell>{formatDuration(employee.weekSeconds)}</Cell>
      <td className="px-3 py-3 text-right">
        <ActivityPill value={employee.activityPercentage} />
      </td>
      <td className="tnum px-3 py-3 text-right font-mono text-num text-fg-3">
        {employee.lastActivityAt ? since(employee.lastActivityAt, asOf) : "—"}
      </td>
      <td className="px-3 py-3 text-cell text-fg-2">
        {employee.currentSessionStartedAt
          ? `since ${clock(employee.currentSessionStartedAt, false)}`
          : <span className="text-fg-4">none</span>}
      </td>
    </tr>
  );
}

/**
 * Online / working / offline, as one badge with three states and a fourth
 * qualifier.
 *
 * "Online, no data" is its own reading and not a synonym for inactive: it means
 * the portal has a shift open and has never heard from a Monitor, which is a
 * thing to go and check rather than a thing to hold against somebody.
 */
function StateBadge({ employee }: { employee: EmployeeTimeRow }) {
  if (!employee.online) {
    return (
      <span className="flex items-center gap-2 text-cell text-fg-4">
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-4" />
        Offline
      </span>
    );
  }

  if (employee.working) {
    return (
      <span className="flex items-center gap-2 text-cell text-fg">
        <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
          <span className="pulse-ring absolute inset-0 rounded-full bg-success" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-success" />
        </span>
        Working
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2 text-cell text-fg-2">
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
      {employee.activityPercentage === null ? "Online, no data" : "Inactive"}
    </span>
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
          <p className="display-num mt-1.5 text-[26px] leading-none text-fg">
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

function clock(iso: string, withSeconds = true): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

/**
 * `4m ago`, measured against the payload's own `asOf`.
 *
 * Against the server's instant rather than the browser's, so a workstation whose
 * clock is wrong does not render "in 3 hours" beside a perfectly good reading —
 * the same skew discipline `WorkClock` applies to the shift timer.
 */
function since(iso: string, asOf: string): string {
  const seconds = Math.max(0, Math.round((new Date(asOf).getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
