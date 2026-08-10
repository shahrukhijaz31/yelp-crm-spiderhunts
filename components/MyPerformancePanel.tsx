"use client";

import {
  CalendarCheck,
  CalendarClock,
  PhoneCall,
  PhoneOutgoing,
  Timer,
  Users2,
} from "lucide-react";

import CountUp from "./CountUp";
import { useSpotlight } from "./useSpotlight";
import { useWorkSession } from "./WorkSessionProvider";
import {
  contactRate,
  conversionRate,
  formatClock,
  formatDuration,
  type ActivityDay,
  type PersonalPerformance,
} from "@/lib/performanceRules";

/**
 * My performance — one agent's own screen.
 *
 * Everything here is about the person reading it and nothing here is about
 * anyone else. There are no team totals, no rankings, no colleagues and no
 * route from this screen to the admin report: an agent's view of the portal
 * simply does not contain those things, and the endpoint this page is rendered
 * from could not return them if it did (see `app/api/performance/me/route.ts`).
 *
 * It is the fuller version of the "My day" band on the worklist, which is why
 * it is a page rather than more rows on that band: this is somewhere you go to
 * look, and it can afford a week's worth of shape and the two rates that need a
 * sentence of context each.
 *
 * There is no target and no goal bar anywhere on it. Every figure is a count of
 * something the reader saved, and a round number nobody in the system chose
 * would be read as one somebody did.
 *
 * The figures are rendered by the server and handed in. The one exception is
 * the running clock, which cannot be — see the note on it below.
 */
export default function MyPerformancePanel({
  performance,
  name,
}: {
  performance: PersonalPerformance;
  name: string;
}) {
  const { startedAt, elapsedSeconds } = useWorkSession();
  const { today, week, daily } = performance;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header>
        <h1 className="page-title">My performance</h1>
        <p className="mt-2 page-intro">
          {firstName(name)}, here is your own record — today and the last seven
          days. Every figure counts work you saved; nothing here is an estimate.
        </p>
      </header>

      {/* --- the active session ------------------------------------------ */}
      <ActiveSessionCard startedAt={startedAt} elapsedSeconds={elapsedSeconds} />

      {/* --- today ------------------------------------------------------- */}
      <section aria-labelledby="today-heading" className="flex flex-col gap-3">
        <h2 id="today-heading" className="text-caption font-medium text-fg-2">
          Today
        </h2>

        {/* Five, not four: callbacks is now a figure of its own rather than a
            footnote under meetings, which is what the goal panel below used to
            be paying for. */}
        <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line lg:grid-cols-5">
          <Metric
            icon={Users2}
            value={today.leadsWorked}
            label="Leads worked"
            hint="a call outcome saved"
          />
          <Metric
            icon={PhoneOutgoing}
            value={today.calls}
            label="Calls"
            hint={`${today.contacts} answered`}
          />
          <Metric
            icon={CalendarClock}
            value={today.callbacks}
            label="Callbacks"
            hint="put in the diary"
          />
          <Metric
            icon={CalendarCheck}
            value={today.meetingsBooked}
            label="Meetings booked"
            hint={`${today.meetingsCompleted} completed`}
          />
          <Metric
            icon={Timer}
            text={formatDuration(today.activeSeconds)}
            label="Active time"
            hint="signed in today"
          />
        </div>
      </section>

      {/* --- the week ---------------------------------------------------- */}
      <section aria-labelledby="week-heading" className="flex flex-col gap-3">
        <h2 id="week-heading" className="text-caption font-medium text-fg-2">
          Last 7 days
        </h2>

        <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line lg:grid-cols-4">
          <Metric icon={Users2} value={week.leadsWorked} label="Leads worked" hint="over 7 days" />
          <Metric
            icon={PhoneCall}
            text={rate(contactRate(week))}
            label="Answer rate"
            hint={`${week.contacts} of ${week.calls} calls answered`}
          />
          <Metric
            icon={CalendarClock}
            text={rate(conversionRate(week))}
            label="Interest rate"
            hint={`${week.interested} interested of ${week.leadsWorked} worked`}
          />
          <Metric
            icon={Timer}
            text={formatDuration(week.activeSeconds)}
            label="Active time"
            hint={`${formatDuration(Math.round(week.activeSeconds / 7))} a day on average`}
          />
        </div>

        <DailyChart days={daily} />
      </section>
    </div>
  );
}

/**
 * The running shift.
 *
 * The only thing on this page the server cannot render: the seconds move. It
 * still is not a browser timer in any meaningful sense — the *start instant*
 * comes from the `work_sessions` row in Postgres and the browser only counts
 * from it, which is why a refresh does not reset it and two tabs agree. When
 * there is no open session it says so plainly rather than showing a stopped
 * clock at zero.
 */
function ActiveSessionCard({
  startedAt,
  elapsedSeconds,
}: {
  startedAt: string | null;
  elapsedSeconds: number | null;
}) {
  if (!startedAt) {
    return (
      <section className="panel px-5 py-4">
        <p className="eyebrow">Active session</p>
        <p className="mt-2 text-ui text-fg-3">
          No session is running. Signing in starts one.
        </p>
      </section>
    );
  }

  const since = new Date(startedAt);
  const loggedInAt = since.toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <section className="panel edge-accent relative isolate overflow-hidden px-5 py-4">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(22rem_12rem_at_100%_0%,var(--c-wash-accent),transparent_70%)]"
      />
      <p className="flex items-center gap-2">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
        <span className="eyebrow">Active session</span>
      </p>
      <p className="display-num mt-2 text-[34px] leading-none tnum text-fg">
        {elapsedSeconds === null ? "—" : formatClock(elapsedSeconds)}
      </p>
      <p className="mt-2 text-meta text-fg-3">
        Signed in at {loggedInAt}. The clock is read from the session recorded in
        the database, so it survives a refresh.
      </p>
    </section>
  );
}

/**
 * Seven days of calls, as bars.
 *
 * Bars rather than a line: these are counts of separate days, not samples of a
 * continuous quantity, and a line between them would draw a Tuesday afternoon
 * that never existed. Scaled to the busiest day in the window, so the shape of
 * a quiet week is still readable — an axis fixed to some round number would
 * flatten every real week into nothing.
 */
function DailyChart({ days }: { days: ActivityDay[] }) {
  const peak = Math.max(1, ...days.map((day) => day.calls));

  return (
    <div className="panel px-5 py-4">
      <h3 className="text-caption font-medium text-fg-2">Calls per day</h3>
      <div className="mt-4 flex items-end gap-2" style={{ height: 108 }}>
        {days.map((day, index) => {
          const height = (day.calls / peak) * 100;
          return (
            <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <div className="flex h-[84px] w-full items-end">
                <span
                  title={`${day.day}: ${day.calls} call${day.calls === 1 ? "" : "s"}, ${day.leadsWorked} lead${day.leadsWorked === 1 ? "" : "s"} worked`}
                  className="grow rounded-t-[3px] bg-accent/70 transition-[height] duration-500 ease-out hover:bg-accent"
                  style={{
                    // A floor of 2px so a zero day is a visible baseline rather
                    // than a gap the eye reads as missing data.
                    height: `${Math.max(2, height)}%`,
                    transitionDelay: `${index * 40}ms`,
                  }}
                />
              </div>
              <span className="truncate text-meta text-fg-4">{weekday(day.day)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Metric({
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

/** A percentage, or an em dash when there is not enough behind it to divide. */
function rate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

/** `2026-08-10` -> `Mon`. */
function weekday(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-GB", {
    weekday: "short",
  });
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
