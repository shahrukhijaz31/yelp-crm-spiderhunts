"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { HEARTBEAT_SECONDS, type WorkClock } from "@/lib/performanceRules";

/**
 * The work clock, for anything on screen that shows it.
 *
 * **The database is the source of truth; this only counts.** Nothing here
 * decides when a shift began, when it ended, or how long anybody has worked.
 * The server hands over three facts — when the open session started, how many
 * seconds of *finished* sessions today already amount to, and what time the
 * server thinks it is — and this derives two display figures from them. A
 * React counter incrementing from zero appears nowhere in this file, which is
 * why a refresh, a navigation, a sleeping laptop and a second tab all show the
 * same number.
 *
 * ---------------------------------------------------------------------------
 * Two figures, and why they cannot double-count
 * ---------------------------------------------------------------------------
 *
 *   currentSessionSeconds  now − startedAt. Zero when nothing is running.
 *   todayTotalSeconds      completedSecondsToday + the running session's part
 *                          of today.
 *
 * `completedSecondsToday` counts **closed sessions only**. The open one is
 * added exactly once, here, and there is no arrangement of these numbers that
 * counts it twice — that is a property of how the server splits them, not of
 * this component remembering to be careful. An earlier version added a live
 * figure on top of a server total that already included the open session, and
 * the day's time ran at roughly double speed.
 *
 * ---------------------------------------------------------------------------
 * Signing out and back in
 * ---------------------------------------------------------------------------
 *
 * The **current session** restarts at zero, because it is a new session — that
 * is what the row means, and each login's row is kept permanently. **Today's
 * total does not**, because it is a sum over every session that started today,
 * not a property of the one in progress. That is the whole of the reported bug:
 * the clock was right, but the only figure on screen was the one that is
 * supposed to restart.
 *
 * ---------------------------------------------------------------------------
 * Whose clock
 * ---------------------------------------------------------------------------
 *
 * `serverNow` arrives with every response and is compared against `Date.now()`
 * to get this machine's skew, which is then subtracted from every reading. A
 * workstation whose clock is ten minutes fast would otherwise show a ten-minute
 * session the instant somebody signed in — the persisted timestamps are the
 * server's, so the displayed elapsed time has to be measured against the
 * server's clock too. The skew is re-measured on every heartbeat, so a machine
 * that drifts is corrected once a minute.
 *
 * ---------------------------------------------------------------------------
 * The heartbeat
 * ---------------------------------------------------------------------------
 *
 * Every {@link HEARTBEAT_SECONDS} an open tab tells the server it is still
 * there, which is what lets a session whose browser died be closed at its last
 * heartbeat instead of running forever. It is sent from here, once per tab,
 * rather than from a timer component — the beat is about the *tab being open*,
 * so it must not stop because somebody navigated to a screen that draws no
 * clock. Several tabs beating at once is harmless and intended: they all touch
 * the same row, and the row is one shift. Nothing about the duration is derived
 * from how many beats arrive, so ten tabs are not ten hours.
 *
 * A hidden tab does not beat. That is the seam where genuine idle detection
 * would go later: stop beating after N minutes without input and the same table
 * starts recording active time instead of session time, with nothing else in
 * the application changing.
 */

const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;

interface WorkSessionValue {
  /** ISO instant the current shift began, or null when none is running. */
  startedAt: string | null;
  /**
   * Seconds since it began, ticking. Null before the first client tick — the
   * server cannot render a live clock, and a value here during SSR would be a
   * hydration mismatch.
   */
  currentSessionSeconds: number | null;
  /** Every session today, including the one running. Null before the first tick. */
  todayTotalSeconds: number | null;
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
  initialClock,
  children,
}: {
  initialClock: WorkClock | null;
  children: React.ReactNode;
}) {
  /**
   * The server's answer, and this machine's error against it.
   *
   * They are one piece of state because they are one observation: the skew is
   * only meaningful for the `serverNow` it was measured against, and storing
   * them apart would let a re-render pair a fresh clock with a stale offset.
   *
   * The skew is measured in the fetch callback — never during render. Reading
   * `Date.now()` while rendering is impure: React may render a component more
   * than once for one commit, and a figure derived from a clock read at render
   * time is not guaranteed to be the figure that gets committed.
   *
   * It starts at zero for the server-rendered clock and is corrected by the
   * first heartbeat, which is fired on mount — so a machine with a badly wrong
   * clock is right within a second rather than wrong all day.
   */
  const [state, setState] = useState<{ clock: WorkClock | null; skewMs: number }>({
    clock: initialClock,
    skewMs: 0,
  });
  const clock = state.clock;
  /**
   * The wall clock, sampled once a second while a session is open.
   *
   * Both figures are *derived* from this during render rather than stored,
   * which is what keeps them correct across a sleeping machine: every value
   * comes from a fresh `Date.now()`, so nothing accumulates drift and nothing
   * has to be corrected after a resume.
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

      const payload = (await response.json()) as { clock?: WorkClock | null };
      if (!payload.clock) return;

      // Measured here, at the moment the answer arrives, and stored with the
      // answer it belongs to. Includes the response's travel time, which is a
      // fraction of a second and biases the clock *down* — a shift is never
      // reported as longer than it was.
      const next = payload.clock;
      setState({ clock: next, skewMs: Date.now() - new Date(next.serverNow).getTime() });
    } catch {
      // Offline, or the server restarting mid-deploy. The grace window is five
      // beats wide, so a missed one costs nothing and a banner would cost an
      // agent their attention in the middle of a call.
    }
  }, []);

  // The tick. Only runs while there is a session to count — a portal with no
  // open shift costs no timer at all.
  useEffect(() => {
    if (!clock?.startedAt) return;

    const tick = () => setNowMs(Date.now());
    // The first sample on the next macrotask rather than in the effect body: a
    // synchronous setState here would be a second render before paint, for a
    // value one frame newer than the interval is about to produce anyway.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);

    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [clock?.startedAt]);

  // The beat: one on mount, one a minute, and one whenever the tab comes back
  // to the front — that last closes the gap left by a tab that was hidden and
  // therefore silent.
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

  const value = useMemo<WorkSessionValue>(() => {
    if (!clock) {
      return { startedAt: null, currentSessionSeconds: null, todayTotalSeconds: null };
    }

    // Before the first tick there is no client clock to read, so both live
    // figures stay null and the components render their placeholder rather than
    // a number that would change on hydration.
    if (nowMs === null) {
      return {
        startedAt: clock.startedAt,
        currentSessionSeconds: null,
        todayTotalSeconds: clock.startedAt ? null : clock.completedSecondsToday,
      };
    }

    // Subtracting the measured offset makes every reading below a *server*
    // reading rather than a workstation one.
    const serverNowMs = nowMs - state.skewMs;

    const startedMs = clock.startedAt ? new Date(clock.startedAt).getTime() : null;
    const currentSessionSeconds =
      startedMs === null ? null : Math.max(0, Math.floor((serverNowMs - startedMs) / 1000));

    // The running session's contribution to *today* — clamped at midnight, so a
    // shift that began yesterday evening adds only the part after it and the
    // total means "worked today" rather than "worked since I signed in".
    const todayStartMs = new Date(clock.todayStart).getTime();
    const countFromMs = startedMs === null ? null : Math.max(startedMs, todayStartMs);
    const openSecondsToday =
      countFromMs === null ? 0 : Math.max(0, Math.floor((serverNowMs - countFromMs) / 1000));

    return {
      startedAt: clock.startedAt,
      currentSessionSeconds,
      // The one addition, and the only place the open session is added at all.
      todayTotalSeconds: clock.completedSecondsToday + openSecondsToday,
    };
  }, [clock, nowMs, state.skewMs]);

  return (
    <WorkSessionContext.Provider value={value}>{children}</WorkSessionContext.Provider>
  );
}
