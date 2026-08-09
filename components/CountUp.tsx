"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that counts into place the first time it is shown, and thereafter
 * animates between values when it changes.
 *
 * The point is not decoration — it is that a figure which *arrives* is a figure
 * you notice has changed. An agent working down a call list sees "Overdue" tick
 * from 4 to 3 in the corner of their eye; a number that simply swaps is a
 * number nobody registers.
 *
 * Constraints that keep it honest:
 *
 *   **It never shows a wrong number at rest.** The animation always ends on
 *   the exact `value` prop, and any interrupted run is cancelled and restarted
 *   from wherever it had got to — so rapid edits cannot leave a stale figure.
 *
 *   **It renders the real value on the server.** Initial state is `value`, not
 *   zero, so the SSR'd HTML and the first client paint both contain the true
 *   count. The count-in starts after mount. Nothing here can produce a
 *   hydration mismatch, and a client with JS disabled sees the right number.
 *
 *   **It respects reduced motion**, by reading the media query rather than by
 *   relying on CSS — this is a JS animation and no stylesheet can stop it.
 *
 * 700ms with an ease-out cubic: fast enough not to be waited on, slow enough
 * that the eye reads it as motion rather than as a flicker.
 */
const DURATION_MS = 700;

export default function CountUp({
  value,
  /** Rendered around the number, e.g. a thousands-separated string. */
  format = (n: number) => n.toLocaleString(),
}: {
  value: number;
  format?: (value: number) => string;
}) {
  const [shown, setShown] = useState(value);
  const frame = useRef<number | null>(null);
  // What is currently on screen, read synchronously by the next animation so
  // an interrupted run continues from where it was rather than jumping.
  const current = useRef(value);
  const mounted = useRef(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // The first pass counts up from zero; later ones travel from the figure
    // already on screen. Counting from zero on every change would make a
    // 612 → 611 edit sweep the whole range, which is nonsense.
    const from = mounted.current ? current.current : 0;
    mounted.current = true;

    if (reduced || from === value) {
      current.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const distance = value - from;

    const step = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= DURATION_MS) {
        current.current = value;
        setShown(value);
        frame.current = null;
        return;
      }
      // Ease-out cubic: most of the distance is covered early, so the number
      // settles rather than arriving at speed.
      const progress = 1 - (1 - elapsed / DURATION_MS) ** 3;
      const next = Math.round(from + distance * progress);
      current.current = next;
      setShown(next);
      frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [value]);

  return <>{format(shown)}</>;
}
