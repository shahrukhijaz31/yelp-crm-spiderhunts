"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ArrowLeft, Camera, CalendarCheck, PhoneOutgoing, Timer } from "lucide-react";

import CountUp from "./CountUp";
import { ActivityPill } from "./TimeTrackingPanel";
import { useSpotlight } from "./useSpotlight";
import {
  formatActivity,
  type ActivityIntervalCard,
  type TimeAdjustmentCard,
  type TrackedSession,
} from "@/lib/activityRules";
import { formatDuration, RANGE_LABELS, type RangeKey } from "@/lib/performanceRules";
import type { EmployeeTimeDetail } from "@/lib/timeTracking";

/**
 * One employee's tracking record — the administrator's detail screen.
 *
 * Behind `apiAdmin()` at the endpoint and `requireRole("ADMIN")` at the page, as
 * everything under `/reports` is. Nothing in this component is what keeps an
 * agent out.
 *
 * **The correction dialog is the only write on any tracking screen.** It posts
 * to `/api/time-adjustments`, which is admin-only and which writes the change
 * and its audit row in one transaction — so a corrected session and the record
 * of who corrected it cannot come apart. The previous values are kept forever
 * and are listed at the foot of this page; nothing here can edit or remove one.
 *
 * Only *finished* sessions offer a Correct button. An open shift is still being
 * written by the agent's own heartbeat, and reaching into it would mean two
 * writers on one row — see the note on `applyTimeAdjustment`.
 *
 * Screenshots are a count with a link to the existing viewer rather than a grid
 * of their own. The viewer already handles authorization, storage keys and byte
 * streaming; a second implementation here would be a second place that decides
 * who may see a screenshot, and the second one is the one that gets it wrong.
 */
export default function EmployeeTimePanel({
  detail,
  rangeKey,
}: {
  detail: EmployeeTimeDetail;
  rangeKey: RangeKey;
}) {
  const router = useRouter();
  const [correcting, setCorrecting] = useState<TrackedSession | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/reports/time"
            className="mb-2 inline-flex items-center gap-1.5 text-meta text-fg-3 underline-offset-2 hover:text-fg hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            All employees
          </Link>
          <h1 className="page-title">{detail.user.name}</h1>
          <p className="mt-2 page-intro">
            {detail.user.role === "ADMIN" ? "Administrator" : "Agent"} ·{" "}
            {detail.user.username}
            {!detail.user.isActive && " · account disabled"}
          </p>
        </div>

        {/* The period. Plain links rather than a fetching control: this screen
            is server-rendered per range, so a link is both simpler and
            shareable — an administrator can send a colleague the exact view. */}
        <nav aria-label="Period" className="flex flex-wrap gap-1.5">
          {(["today", "yesterday", "last7", "last30"] as const).map((key) => (
            <Link
              key={key}
              href={`/reports/time/${detail.user.id}?range=${key}`}
              data-active={rangeKey === key}
              className="rounded-md border border-line px-2.5 py-1.5 text-meta text-fg-3 transition-colors hover:text-fg data-[active=true]:border-line-2 data-[active=true]:bg-recessed data-[active=true]:text-fg"
            >
              {RANGE_LABELS[key]}
            </Link>
          ))}
        </nav>
      </header>

      {/* --- totals ------------------------------------------------------- */}
      <section
        aria-label="Totals for the period"
        className="panel grid grid-cols-2 gap-px overflow-hidden bg-line lg:grid-cols-6"
      >
        <Kpi icon={Timer} text={formatDuration(detail.trackedSeconds)} label="Tracked" hint={detail.range.label.toLowerCase()} />
        <Kpi icon={Activity} text={formatDuration(detail.activeSeconds)} label="Active" hint="time with input" />
        <Kpi icon={Timer} text={formatDuration(detail.idleSeconds)} label="Idle" hint="tracked, without input" />
        <Kpi
          icon={Activity}
          text={formatActivity(detail.activityPercentage)}
          label="Activity"
          hint={detail.activityPercentage === null ? "no data reported" : "weighted over the period"}
        />
        <Kpi
          icon={CalendarCheck}
          value={detail.meetings.booked}
          label="Meetings"
          hint={`${detail.meetings.completed} completed`}
        />
        <Kpi
          icon={Camera}
          value={detail.screenshots.count}
          label="Screenshots"
          hint={
            detail.screenshots.latestCapturedAt
              ? `latest ${clock(detail.screenshots.latestCapturedAt)}`
              : "none in this period"
          }
        />
      </section>

      <p className="text-meta text-fg-4">
        <PhoneOutgoing className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" strokeWidth={1.75} aria-hidden="true" />
        {detail.meetings.callsLogged.toLocaleString()} call outcomes saved in this period ·{" "}
        <Link
          href={`/screenshots?agent=${detail.user.id}`}
          className="underline-offset-2 hover:text-fg hover:underline"
        >
          open the screenshot viewer
        </Link>
      </p>

      {/* --- sessions ----------------------------------------------------- */}
      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Work sessions</h2>
          <p className="text-meta text-fg-4">{detail.sessions.length} in this period</p>
        </div>

        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow px-5 py-2 text-left">Started</th>
                <th scope="col" className="eyebrow px-3 py-2 text-left">Ended</th>
                <Head>Tracked</Head>
                <Head>Active</Head>
                <Head>Idle</Head>
                <Head>Activity</Head>
                <Head>Shots</Head>
                <th scope="col" className="eyebrow px-3 py-2 text-right">
                  <span className="sr-only">Correct</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.sessions.map((session) => (
                <tr key={session.id} className="border-b border-line last:border-b-0">
                  <td className="px-5 py-3 text-cell text-fg">
                    {dayAndClock(session.startedAt)}
                    {session.adjusted && (
                      <span
                        title="Corrected by an administrator"
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
                  <td className="px-3 py-3 text-right">
                    {session.endedAt ? (
                      <button
                        type="button"
                        onClick={() => setCorrecting(session)}
                        className="ui-btn ui-btn-ghost h-7 px-2 text-caption"
                      >
                        Correct
                      </button>
                    ) : (
                      <span className="text-meta text-fg-4" title="Corrections are only made to finished sessions">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {detail.sessions.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-ui text-fg-3">
                    No work sessions in this period.
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
          <h2 className="text-caption font-medium text-fg-2">Activity intervals</h2>
          <p className="text-meta text-fg-4">newest {detail.intervals.length}</p>
        </div>

        {detail.intervals.length === 0 ? (
          <p className="px-5 py-8 text-center text-ui text-fg-3">
            No activity has been reported for this employee. This needs the
            SpiderHunts Monitor running on their workstation.
          </p>
        ) : (
          <ul className="flex flex-col">
            {detail.intervals.map((interval) => (
              <IntervalRow key={interval.id} interval={interval} />
            ))}
          </ul>
        )}
      </section>

      {/* --- the audit trail ---------------------------------------------- */}
      <section className="panel overflow-hidden">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-caption font-medium text-fg-2">Manual corrections</h2>
        </div>

        {detail.adjustments.length === 0 ? (
          <p className="px-5 py-6 text-center text-ui text-fg-3">
            No corrections have been made to this employee&rsquo;s time.
          </p>
        ) : (
          <ul className="flex flex-col">
            {detail.adjustments.map((adjustment) => (
              <AdjustmentRow key={adjustment.id} adjustment={adjustment} />
            ))}
          </ul>
        )}
      </section>

      {correcting && (
        <CorrectionDialog
          session={correcting}
          agentName={detail.user.name}
          onClose={() => setCorrecting(null)}
          onSaved={() => {
            setCorrecting(null);
            // The server owns every figure on this page, so the honest refresh
            // is to re-render it rather than to patch a row in local state and
            // hope the totals still agree with it.
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Correct a finished session.
 *
 * The two instants and a reason, and nothing else — this dialog cannot delete a
 * session, cannot create one, cannot touch an activity interval and cannot
 * change whose session it is. The reason is required by the endpoint as well as
 * by this form, because a correction with no stated reason is indistinguishable
 * from tampering six months later.
 *
 * `datetime-local` sends a value with no zone, which is read as the reader's own
 * local time — the same zone every other instant on this screen is displayed in.
 * It is converted to an ISO instant on the way out so the server never has to
 * guess what "14:30" meant.
 */
function CorrectionDialog({
  session,
  agentName,
  onClose,
  onSaved,
}: {
  session: TrackedSession;
  agentName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startedAt, setStartedAt] = useState(toLocalInput(session.startedAt));
  const [endedAt, setEndedAt] = useState(toLocalInput(session.endedAt ?? session.startedAt));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextSeconds = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
  );

  async function save() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/time-adjustments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workSessionId: session.id,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          reason,
        }),
      });

      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        setError(body.message ?? "Could not save that correction.");
        return;
      }

      onSaved();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="correction-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* The scrim is a button so dismissing by clicking away is reachable from
          the keyboard too — the same construction `BookMeetingDialog` uses. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-base/60 backdrop-blur-[3px]"
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="panel-float pop-in relative w-full max-w-md p-4 [--pop-origin:center]"
      >
        <h2 id="correction-title" className="text-cell font-medium tracking-[-0.015em] text-fg">
          Correct a work session
        </h2>
        <p className="mt-1 text-caption text-fg-3">
          {agentName} · {dayAndClock(session.startedAt)} ·{" "}
          <span className="tnum font-mono text-fg-2">
            {formatDuration(session.trackedSeconds)}
          </span>{" "}
          recorded
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="field-label">Started</span>
            <input
              type="datetime-local"
              value={startedAt}
              onChange={(event) => setStartedAt(event.target.value)}
              className="ui-field"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="field-label">Ended</span>
            <input
              type="datetime-local"
              value={endedAt}
              min={startedAt}
              onChange={(event) => setEndedAt(event.target.value)}
              className="ui-field"
            />
          </label>
        </div>

        <p className="mt-2.5 text-meta text-fg-3">
          New duration{" "}
          <span className="tnum font-mono text-fg">{formatDuration(nextSeconds)}</span>, was{" "}
          <span className="tnum font-mono text-fg-2">
            {formatDuration(session.trackedSeconds)}
          </span>
          .
        </p>

        <label className="mt-3 flex flex-col gap-1">
          <span className="field-label">Reason</span>
          <textarea
            rows={3}
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. laptop crashed at 16:00; agent confirmed working until 18:00"
            className="ui-field w-full resize-y py-2"
          />
        </label>

        <p className="mt-2.5 text-meta leading-relaxed text-fg-3">
          The previous values, your name and the time of this change are kept
          permanently. Nothing is overwritten without a record.
        </p>

        {error && <p className="mt-2 text-meta text-danger">{error}</p>}

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={busy || reason.trim().length < 3 || nextSeconds <= 0}
            className="ui-btn ui-btn-primary h-9"
          >
            {busy ? "Saving…" : "Save correction"}
          </button>
          <button type="button" onClick={onClose} disabled={busy} className="ui-btn ui-btn-ghost h-9">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function AdjustmentRow({ adjustment }: { adjustment: TimeAdjustmentCard }) {
  return (
    <li className="border-b border-line px-5 py-3 last:border-b-0">
      <p className="text-cell text-fg">
        <span className="tnum font-mono">
          {formatDuration(adjustment.previousDurationSeconds ?? 0)}
        </span>
        {" → "}
        <span className="tnum font-mono">
          {formatDuration(adjustment.newDurationSeconds ?? 0)}
        </span>
        <span className="ml-2 text-meta text-fg-4">
          {dayAndClock(adjustment.previousStartedAt)} session
        </span>
      </p>
      <p className="mt-1 text-meta text-fg-3">
        {adjustment.reason}
      </p>
      <p className="mt-1 text-meta text-fg-4">
        by {adjustment.adminName} · {new Date(adjustment.createdAt).toLocaleString()}
      </p>
    </li>
  );
}

function IntervalRow({ interval }: { interval: ActivityIntervalCard }) {
  return (
    <li className="flex items-center gap-4 border-b border-line px-5 py-2.5 last:border-b-0">
      <span className="tnum shrink-0 font-mono text-num text-fg-2">
        {dayAndClock(interval.startedAt)}
      </span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full bg-accent/70"
          style={{ width: `${Math.max(2, interval.activityPercentage)}%` }}
        />
      </span>
      <span className="shrink-0 text-meta text-fg-4">
        {interval.keyboardActivityCount.toLocaleString()} keys ·{" "}
        {interval.mouseActivityCount.toLocaleString()} mouse
      </span>
      <span className="tnum w-12 shrink-0 text-right font-mono text-num text-fg">
        {interval.activityPercentage}%
      </span>
    </li>
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

function dayAndClock(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(iso, false)}`;
}

/** An ISO instant as the `YYYY-MM-DDTHH:MM` a `datetime-local` input wants. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
