"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarCheck,
  CalendarClock,
  PhoneOutgoing,
  Timer,
  Users2,
} from "lucide-react";

import CountUp from "./CountUp";
import { useWorkSession } from "./WorkSessionProvider";
import { formatDuration, type PersonalPerformance } from "@/lib/performanceRules";

/**
 * "My day" — the agent's own numbers, above the worklist.
 *
 * Five figures on one band. It is deliberately *not* a
 * dashboard: an agent glancing up between calls wants to know how the day is
 * going, and a management report in that position would be read once and then
 * ignored forever. The full picture — this week, contact and conversion rates,
 * the session log — is one click away on `/my-performance`, which is where
 * somebody goes when they actually want to look.
 *
 * **Only ever the caller's own row.** The data comes from
 * `GET /api/performance/me`, which takes no parameters at all and queries the
 * session's own user id (see the note there). There is no agent picker here and
 * no shape of request this component could make that would return anybody
 * else's figures — an agent could not see a colleague's day by editing the
 * JavaScript, because the endpoint has nothing to edit.
 *
 * **Every number here is a count of something saved**, without exception.
 * "Leads worked" is distinct leads a call outcome was recorded against — not
 * leads opened, not rows scrolled past — and "Active time" is the sum of
 * persisted work sessions, not a browser timer. There is no target and no
 * progress bar: a goal nobody in the system chose, rendered in the same
 * typeface as the measurements beside it, is read as a measurement. The band
 * reports the day and leaves the judgement to the person having it.
 */
export default function MyDayStrip({
  /** Bumped by the screen when a lead is saved, so the numbers move as work happens. */
  revision = 0,
}: {
  revision?: number;
}) {
  const { elapsedSeconds } = useWorkSession();
  const [performance, setPerformance] = useState<PersonalPerformance | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/performance/me", { credentials: "same-origin" });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const payload = (await response.json()) as { performance: PersonalPerformance };
      setPerformance(payload.performance);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // On mount, whenever a save happens, and when the tab comes back to the
  // front — the three moments the figures can have changed under it.
  useEffect(() => {
    // On the next macrotask rather than in the effect body, so the fetch's
    // eventual setState is never a synchronous cascade off this render.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, revision]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // Nothing at all until the first response. A band of zeroes that turns into
  // real numbers a moment later reads as "you have done nothing today", which
  // is the one message this must never show by accident.
  if (!performance) {
    if (failed) return null;
    return <div aria-hidden="true" className="h-[68px] shrink-0" />;
  }

  const today = performance.today;

  /*
   * The live figure, not the stored one.
   *
   * `today.activeSeconds` is what Postgres summed when the request was answered
   * and stops moving between polls; the open session's own clock is ticking in
   * `WorkSessionProvider`. Adding the seconds elapsed *since the response* to
   * the server's total keeps the two in step without polling once a second —
   * the server stays the source of truth for everything already banked, and the
   * browser only ever contributes the sliver since it last asked.
   */
  const liveActiveSeconds =
    elapsedSeconds === null
      ? today.activeSeconds
      : today.activeSeconds + secondsSince(performance.todayIso, elapsedSeconds);

  return (
    <section
      aria-label="My day"
      className="panel rise-in overflow-hidden"
      style={{ "--rise": "6px" } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <p className="eyebrow">My day</p>
        </div>

        {/* The figures. A row rather than five cards: they are one summary of
            one person's morning, and boxing each of them would make five
            unrelated widgets out of it.

            Callbacks takes the space the goal bar used to occupy. It is the
            fifth thing an agent does all day and — unlike a target — it is a
            count of rows they wrote, which is the only kind of number this
            band carries. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
          <Figure icon={Users2} value={today.leadsWorked} label="Leads worked" />
          <Figure icon={PhoneOutgoing} value={today.calls} label="Calls" />
          <Figure icon={CalendarClock} value={today.callbacks} label="Callbacks" />
          <Figure icon={CalendarCheck} value={today.meetingsBooked} label="Meetings" />
          <Figure icon={Timer} text={formatDuration(liveActiveSeconds)} label="Active" />
        </div>

        <Link
          href="/my-performance"
          className="ui-btn ui-btn-ghost h-8 shrink-0 gap-1 text-caption"
        >
          Details
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}

/**
 * How much of the running session falls inside today.
 *
 * A shift that began yesterday evening is still open this morning, and the
 * whole of its elapsed time is not today's work. `elapsedSeconds` counts from
 * the session's start; this trims it to the part on or after local midnight, so
 * the live sliver added to the server's total covers the same window the server
 * was counting.
 */
function secondsSince(todayIso: string, elapsedSeconds: number): number {
  const [year, month, day] = todayIso.split("-").map(Number);
  const midnight = new Date(year, (month ?? 1) - 1, day ?? 1).getTime();
  const sessionStart = Date.now() - elapsedSeconds * 1000;
  const countFrom = Math.max(midnight, sessionStart);
  return Math.max(0, Math.floor((Date.now() - countFrom) / 1000));
}

function Figure({
  icon: Icon,
  value,
  text,
  label,
}: {
  icon: React.ElementType;
  value?: number;
  text?: string;
  label: string;
}) {
  return (
    <p className="flex shrink-0 items-baseline gap-2">
      <Icon
        className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-fg-4"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="tnum font-mono text-num font-semibold text-fg">
        {text ?? <CountUp value={value ?? 0} />}
      </span>
      <span className="text-caption text-fg-3">{label}</span>
    </p>
  );
}
