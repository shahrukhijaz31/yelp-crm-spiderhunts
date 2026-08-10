"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * The running work-session clock, for anything on screen that shows it.
 *
 * **The clock is read, not kept.** The session's start instant comes from the
 * `work_sessions` row in Postgres, rendered into the shell by the portal
 * layout; this only counts up from it. So a refresh does not reset the timer, a
 * second tab shows the same number as the first, and closing the browser for an
 * hour and coming back shows the hour — because none of those touch the row the
 * figure is derived from. Elapsed time is recomputed from `Date.now()` on every
 * tick rather than incremented by one, which is the difference between a clock
 * that survives a sleeping laptop and one that quietly runs slow.
 *
 * **The heartbeat is the other half.** Every {@link HEARTBEAT_MS} an open tab
 * tells the server it is still here, which is what lets a session whose browser
 * died be closed at its last heartbeat instead of running forever (see
 * `lib/workSessions.ts`). It is sent from here, once per tab, rather than from
 * the timer component — the beat is about the *tab being open*, and it must not
 * stop because somebody navigated to a screen that happens not to draw a clock.
 *
 * Several tabs beating at once is harmless and is the intended behaviour: they
 * all touch the same row, and the row is one shift. Nothing about the duration
 * is derived from how many beats arrive.
 *
 * A hidden tab does not beat. That is what makes the measurement mean "a portal
 * is open in front of somebody" rather than "a laptop is switched on", and it
 * is the seam where genuine idle detection would go later: stop beating after
 * N minutes without input and the same table starts recording active time
 * instead of session time, with nothing else in the app changing.
 */

/** Matches `HEARTBEAT_SECONDS` in `lib/workSessions.ts`. */
const HEARTBEAT_MS = 60_000;

interface WorkSessionValue {
  /** ISO instant the current shift began, or null when there is no open one. */
  startedAt: string | null;
  /**
   * Seconds since it began, ticking. Null before the first client tick — the
   * server cannot render a live clock, and pretending it can is a hydration
   * mismatch that React will replace on the next frame anyway.
   */
  elapsedSeconds: number | null;
}

const WorkSessionContext = createContext<WorkSessionValue | null>(null);

export function useWorkSession(): WorkSessionValue {
  const value = useContext(WorkSessionContext);
  if (!value) {
    throw new Error("useWorkSession must be used inside <WorkSessionProvider>");
  }
  return value;
}

export function WorkSessionProvider({
  initialStartedAt,
  children,
}: {
  initialStartedAt: string | null;
  children: React.ReactNode;
}) {
  const [startedAt, setStartedAt] = useState(initialStartedAt);
  /**
   * The wall clock, sampled once a second while a session is open.
   *
   * The elapsed figure is *derived* from this during render rather than stored,
   * which is what keeps it correct across a sleeping machine: every value comes
   * from a fresh `Date.now()` minus the session's start, so nothing accumulates
   * drift and nothing has to be corrected after a resume. Null until the first
   * client tick — the server cannot render a running clock, and a value here
   * during SSR would be a hydration mismatch.
   */
  const [nowMs, setNowMs] = useState<number | null>(null);

  const beat = useCallback(async () => {
    // A hidden tab is not somebody working. Skipping the beat is what makes a
    // background tab left open overnight stop counting after the grace window.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    try {
      const response = await fetch("/api/work-session/heartbeat", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) return;

      const payload = (await response.json()) as {
        session?: { startedAt?: unknown } | null;
      };
      const next =
        typeof payload.session?.startedAt === "string" ? payload.session.startedAt : null;

      // Adopt the server's answer. It is the authority on when the shift began,
      // and this is how a tab that was open across a reconnect (or across the
      // sweep closing a dead session and a new one opening) corrects itself
      // instead of counting from an instant that is no longer true.
      //
      // The functional form so this callback never has to close over the
      // current value: returning it unchanged when it already matches means an
      // unchanged answer costs no re-render, and `beat` stays stable across the
      // whole life of the tab rather than rebuilding its interval every minute.
      setStartedAt((current) => (next === current ? current : next));
    } catch {
      // Offline, or the server is restarting mid-deploy. The grace window is
      // five beats wide, so a missed one costs nothing and a banner would cost
      // an agent their attention in the middle of a call.
    }
  }, []);

  // The tick. Only runs while there is a session to count — a portal with no
  // open shift costs no timer at all.
  useEffect(() => {
    if (!startedAt) return;

    const tick = () => setNowMs(Date.now());
    // The first sample on the next macrotask rather than in the effect body:
    // a synchronous setState here would be a second render before paint, for a
    // value that is one frame newer than the one the interval is about to
    // produce anyway.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [startedAt]);

  // The beat: one on mount, one a minute, and one whenever the tab comes back
  // to the front — that last is what closes the gap left by a tab that was
  // hidden and therefore silent.
  useEffect(() => {
    const first = setTimeout(() => void beat(), 0);
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [beat]);

  const value = useMemo(() => {
    const begin = startedAt ? new Date(startedAt).getTime() : Number.NaN;
    const elapsedSeconds =
      nowMs === null || !Number.isFinite(begin)
        ? null
        : Math.max(0, Math.floor((nowMs - begin) / 1000));

    return { startedAt, elapsedSeconds };
  }, [startedAt, nowMs]);

  return (
    <WorkSessionContext.Provider value={value}>{children}</WorkSessionContext.Provider>
  );
}
