"use client";

import { useWorkSession } from "./WorkSessionProvider";
import { formatWorkClock } from "@/lib/performanceRules";

/**
 * Today's work time, in the top bar.
 *
 * **One figure, deliberately.** This used to show the current session beside
 * the day's total, and two unlabelled monospaced clocks a few pixels apart is
 * a puzzle rather than a readout — there is nothing in "02h 14m │ 05h 32m" that
 * says which is which. Labelling both would have cost about 90px in a bar that
 * already drops the lead counts below 1024px to fit what is there now.
 *
 * So the two figures were split by *when they are read*. The day's total is the
 * all-day, glanceable one — "how much have I worked" — and it belongs here,
 * beside the other facts about the workspace. The current session is a detail
 * checked occasionally and overwhelmingly at one moment: when somebody is about
 * to sign out. That is in `UserMenu`, directly above the Sign out item, where
 * it is in front of you exactly when it matters and out of the way the rest of
 * the time. `/my-performance` still shows both in full, with seconds.
 *
 * The dot is the only piece of colour: it says the clock is running, which is
 * genuinely state rather than data. Nothing here is rendered in the accent —
 * that is reserved for work actually owed, and a permanently coloured timer on
 * every screen is a thing agents learn to stop seeing.
 *
 * `tnum` and `font-mono` are load-bearing rather than decorative: a
 * proportional clock re-flows as its digits change width, and a number that
 * shifts in the corner of the screen is impossible to stop noticing.
 */
export default function SessionTimer() {
  const { startedAt, todayTotalSeconds } = useWorkSession();

  // A running clock or nothing. A stopped clock in a top bar is worse than an
  // empty space, and before the first client tick there is no clock to show.
  if (!startedAt || todayTotalSeconds === null) return null;

  return (
    <p
      className="hidden items-center gap-1.5 text-caption text-fg-3 md:flex"
      title={`${formatWorkClock(todayTotalSeconds)} worked today, across every session`}
    >
      {/* The accessible name carries the meaning once. The digits are
          `aria-hidden` so a screen reader is not read a new clock every minute
          by the live region this would otherwise become. */}
      <span className="sr-only">
        Today&rsquo;s work time so far, {formatWorkClock(todayTotalSeconds)}.
      </span>

      <span aria-hidden="true" className="relative flex h-1.5 w-1.5 shrink-0">
        {/* A slow ring under a solid dot. Three seconds, because this sits on
            every screen for a whole shift and anything faster becomes something
            to actively ignore. The solid dot never animates, so the indicator
            survives `prefers-reduced-motion` with its meaning intact. */}
        <span className="pulse-ring absolute inset-0 rounded-full bg-success" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-success" />
      </span>

      <span aria-hidden="true" className="tnum font-mono font-medium text-fg-2">
        {formatWorkClock(todayTotalSeconds)}
      </span>
      <span aria-hidden="true" className="text-fg-4">today</span>
    </p>
  );
}
