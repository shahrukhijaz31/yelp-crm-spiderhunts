"use client";

import { Activity, Camera, Keyboard, MousePointer2, Timer, TimerReset } from "lucide-react";

import CountUp from "./CountUp";
import { useSpotlight } from "./useSpotlight";
import { useWorkSession } from "./WorkSessionProvider";
import {
  activityBand,
  formatActivity,
  type ActivityIntervalCard,
  type TrackedSession,
} from "@/lib/activityRules";
import { formatDuration, formatWorkClockLong } from "@/lib/performanceRules";
import type { AgentTimeTracking } from "@/lib/timeTracking";

/**
 * Time tracking — one agent's own screen.
 *
 * Everything here is about the person reading it and nothing here is about
 * anyone else. There are no colleagues, no team totals, no ranking and no route
 * to the admin dashboard; the endpoint this is rendered from could not return
 * those things if there were, because it takes no user id at all
 * (`app/api/time-tracking/me/route.ts`).
 *
 * **It is read-only, and that is a permission rather than a design choice.**
 * There is no edit control on this screen because there is no endpoint behind
 * one: an agent cannot alter a session, delete an interval, change a screenshot
 * or adjust their own tracked time. The only writes in this whole feature are
 * the Monitor's activity submission and an administrator's correction.
 *
 * **Screenshots appear as a count, not as pictures.** `lib/access.ts` is
 * explicit that no agent may see any screenshot, including their own, and this
 * screen does not become the way around it. Showing the count is the part that
 * matters here: monitoring an employee without telling them it is happening is
 * the version of this feature nobody should build, so the number is on their own
 * page, in words, with the cadence beside it.
 *
 * The running clock is the same one the top bar and `/my-performance` draw, from
 * `WorkSessionProvider` — one number, read from one place, so the portal cannot
 * disagree with itself about how long somebody has worked.
 */
export default function TimeTrackingPanel({
  tracking,
  name,
}: {
  tracking: AgentTimeTracking;
  name: string;
}) {
  const { startedAt, currentSessionSeconds, todayTotalSeconds } = useWorkSession();
  const todaySeconds = todayTotalSeconds ?? tracking.todaySeconds;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header>
        <h1 className="page-title">Time tracking</h1>
        <p className="mt-2 page-intro">
          {firstName(name)}, this is your own tracked time and activity. Activity
          counts keyboard and mouse events only — it is not a measure of how well
          the work went, and a long call is a quiet minute on it.
        </p>
      </header>

      {/* --- status ------------------------------------------------------ */}
      <StatusCard
        startedAt={startedAt}
        currentSessionSeconds={currentSessionSeconds}
        working={tracking.working}
        activityPercentage={tracking.activityPercentage}
        lastActivityAt={tracking.lastActivityAt}
        idleThresholdSeconds={tracking.policy.idleThresholdSeconds}
      />

      {/* --- today and the week ------------------------------------------ */}
      <section aria-label="Tracked time" className="panel grid grid-cols-2 gap-px overflow-hidden bg-line lg:grid-cols-5">
        <Metric
          icon={Timer}
          text={formatDuration(todaySeconds)}
          label="Today"
          hint="every session today"
        />
        <Metric
          icon={Activity}
          text={formatDuration(tracking.todayActiveSeconds)}
          label="Active today"
          hint="minutes with input"
        />
        <Metric
          icon={TimerReset}
          text={formatDuration(Math.max(0, todaySeconds - tracking.todayActiveSeconds))}
          label="Idle today"
          hint="tracked, without input"
        />
        <Metric
          icon={Timer}
          text={formatDuration(tracking.weekSeconds)}
          label="This week"
          hint="last 7 days including today"
        />
        <Metric
          icon={Camera}
          value={tracking.screenshots.count}
          label="Screenshots today"
          hint={
            tracking.screenshots.latestCapturedAt
              ? `latest ${clock(tracking.screenshots.latestCapturedAt)}`
              : "none captured yet"
          }
        />
      </section>

      {/* --- sessions ----------------------------------------------------- */}
      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Recent work sessions</h2>
          <p className="text-meta text-fg-4">last 7 days</p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[620px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-5 py-2 text-left">Started</th>
                <th scope="col" className="eyebrow px-3 py-2 text-left">Ended</th>
                <Head>Tracked</Head>
                <Head>Active</Head>
                <Head>Idle</Head>
                <Head>Activity</Head>
                <Head>Shots</Head>
              </tr>
            </thead>
            <tbody>
              {tracking.sessions.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
              {tracking.sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-ui text-fg-3">
                    No work sessions in the last seven days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* --- intervals ---------------------------------------------------- */}
      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Recent activity</h2>
          <p className="text-meta text-fg-4">
            one row per {Math.round(tracking.policy.intervalSeconds / 60) || 1} min
          </p>
        </div>

        {tracking.intervals.length === 0 ? (
          <p className="px-5 py-8 text-center text-ui text-fg-3">
            No activity has been recorded yet. Activity is reported by the
            SpiderHunts Monitor desktop application while you are on the clock.
          </p>
        ) : (
          <ul className="flex flex-col">
            {tracking.intervals.map((interval) => (
              <IntervalRow key={interval.id} interval={interval} />
            ))}
          </ul>
        )}
      </section>

      <p className="text-meta text-fg-4">
        Activity is the share of an interval&rsquo;s keyboard and mouse events
        against a fixed rate the portal sets. It records input, nothing more — no
        keystrokes, no typed text, no mouse positions and nothing about what is on
        your screen is stored.
      </p>
    </div>
  );
}

/**
 * The two things an agent actually looks at: is the clock running, and does the
 * portal think I am active.
 *
 * Both are shown even when they disagree, because they genuinely can: reading a
 * lead's notes for ten minutes is on the clock and not "working" by the input
 * measure. Saying so plainly here is better than picking one and hiding the
 * other, which is how somebody ends up believing their time was not counted.
 */
function StatusCard({
  startedAt,
  currentSessionSeconds,
  working,
  activityPercentage,
  lastActivityAt,
  idleThresholdSeconds,
}: {
  startedAt: string | null;
  currentSessionSeconds: number | null;
  working: boolean;
  activityPercentage: number | null;
  lastActivityAt: string | null;
  idleThresholdSeconds: number;
}) {
  return (
    <section className="panel relative isolate grid grid-cols-1 gap-px overflow-hidden bg-line sm:grid-cols-2">
      <div className="relative isolate overflow-hidden bg-surface px-5 py-4">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(22rem_12rem_at_100%_0%,var(--c-wash-accent),transparent_70%)]"
        />
        <p className="flex items-center gap-2">
          <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
            {startedAt && <span className="pulse-ring absolute inset-0 rounded-full bg-success" />}
            <span
              className={`relative h-1.5 w-1.5 rounded-full ${startedAt ? "bg-success" : "bg-fg-4"}`}
            />
          </span>
          <span className="eyebrow">{startedAt ? "Current session" : "Not working"}</span>
        </p>
        <p className="display-num tnum mt-2 text-[34px] leading-none text-fg">
          {startedAt && currentSessionSeconds !== null
            ? formatWorkClockLong(currentSessionSeconds)
            : "—"}
        </p>
        <p className="mt-2 text-meta text-fg-3">
          {startedAt
            ? `Started at ${clock(startedAt, false)}, when you signed in.`
            : "No session is running. Signing in to the portal starts one."}
        </p>
      </div>

      <div className="bg-surface px-5 py-4">
        <p className="eyebrow">Activity today</p>
        <p className="display-num tnum mt-2 text-[34px] leading-none text-fg">
          {formatActivity(activityPercentage)}
        </p>
        <p className="mt-2 text-meta text-fg-3">
          {activityPercentage === null
            ? "No activity has been reported today. This needs the SpiderHunts Monitor running."
            : working
              ? "Input seen in the last few minutes — you are shown as working."
              : `No input for over ${Math.round(idleThresholdSeconds / 60)} minutes. You are still on the clock.`}
          {lastActivityAt && ` Last input ${clock(lastActivityAt)}.`}
        </p>
      </div>
    </section>
  );
}

function SessionRow({ session }: { session: TrackedSession }) {
  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="px-5 py-3 text-cell text-fg">
        {dayAndClock(session.startedAt)}
        {session.adjusted && (
          <span
            title="An administrator corrected this session"
            className="ml-2 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-3"
          >
            Corrected
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-cell text-fg-2">
        {session.endedAt ? clock(session.endedAt, false) : <span className="text-success">running</span>}
      </td>
      <Cell>{formatDuration(session.trackedSeconds)}</Cell>
      <Cell>{formatDuration(session.activeSeconds)}</Cell>
      <Cell>{formatDuration(session.idleSeconds)}</Cell>
      <td className="px-3 py-3 text-right">
        <ActivityPill value={session.activityPercentage} />
      </td>
      <Cell>{session.screenshotCount}</Cell>
    </tr>
  );
}

function IntervalRow({ interval }: { interval: ActivityIntervalCard }) {
  return (
    <li className="flex items-center gap-4 border-b border-line px-5 py-2.5 last:border-b-0">
      <span className="tnum shrink-0 font-mono text-num text-fg-2">
        {clock(interval.startedAt, false)}
      </span>
      <span className="shrink-0 text-meta text-fg-4">
        {Math.round(interval.durationSeconds / 60) || 1}m
      </span>

      {/* The bar is the row's whole point: a column of them is a shape you can
          read at a glance, which a column of percentages is not. */}
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full bg-accent/70"
          style={{ width: `${Math.max(2, interval.activityPercentage)}%` }}
        />
      </span>

      <span className="flex shrink-0 items-center gap-3 text-meta text-fg-4">
        <span className="flex items-center gap-1" title="keyboard events">
          <Keyboard className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          <span className="tnum">{interval.keyboardActivityCount.toLocaleString()}</span>
        </span>
        <span className="flex items-center gap-1" title="mouse events">
          <MousePointer2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          <span className="tnum">{interval.mouseActivityCount.toLocaleString()}</span>
        </span>
      </span>

      <span className="tnum w-12 shrink-0 text-right font-mono text-num text-fg">
        {interval.activityPercentage}%
      </span>
    </li>
  );
}

/**
 * An activity figure with its band as a tint.
 *
 * Three bands, from `activityBand`, and deliberately not a red/green judgement:
 * the colours run from quiet to strong rather than bad to good, because a low
 * figure is a description of input and not a verdict on the work.
 */
export function ActivityPill({ value }: { value: number | null }) {
  const band = activityBand(value);
  const tint = {
    none: "text-fg-4",
    low: "text-fg-2",
    moderate: "text-fg",
    high: "text-success",
  }[band];

  return <span className={`tnum font-mono text-num ${tint}`}>{formatActivity(value)}</span>;
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

/** `14:32:18` in the reader's own timezone. */
function clock(iso: string, withSeconds = true): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

/** `Mon 09:04` — enough to tell two sessions apart in a week-long list. */
function dayAndClock(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { weekday: "short" })} ${clock(iso, false)}`;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
