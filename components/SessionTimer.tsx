"use client";

import { Timer } from "lucide-react";

import { useWorkSession } from "./WorkSessionProvider";
import { formatClock } from "@/lib/performanceRules";

/**
 * The running shift, in the top bar.
 *
 * Deliberately quiet: a monospaced clock and a small mark, at the same weight
 * as the lead counts beside it. This is a fact about the day, not a
 * notification — a timer rendered in the accent colour would put a permanent
 * red thing on every screen in the application, and the accent is reserved for
 * work that is actually owed.
 *
 * `tnum` and `font-mono` are load-bearing rather than decorative: a
 * proportional clock re-flows on every tick as the digits change width, and a
 * number that jitters once a second in the corner of the screen is impossible
 * to stop noticing.
 *
 * Nothing is rendered before the first client tick, and nothing is rendered
 * when there is no open session. Both are the same decision — the component
 * shows a running clock or it shows nothing, because a stopped clock in a top
 * bar is worse than an empty space.
 */
export default function SessionTimer() {
  const { startedAt, elapsedSeconds } = useWorkSession();

  if (!startedAt || elapsedSeconds === null) return null;

  const since = new Date(startedAt);
  const loggedInAt = since.toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <p
      className="hidden items-center gap-1.5 text-caption text-fg-3 md:flex"
      title={`Active session — signed in at ${loggedInAt}`}
    >
      <Timer className="h-3.5 w-3.5 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />
      {/* The accessible name says what the digits mean; the digits themselves
          are `aria-hidden` so a screen reader is not read a new clock every
          second by the live region it would otherwise become. */}
      <span className="sr-only">Active session, signed in at {loggedInAt}.</span>
      <span aria-hidden="true" className="tnum font-mono font-medium text-fg-2">
        {formatClock(elapsedSeconds)}
      </span>
    </p>
  );
}
