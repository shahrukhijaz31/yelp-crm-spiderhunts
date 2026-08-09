"use client";

import { useCallback, useRef } from "react";

/**
 * Cursor-responsive lighting for a surface.
 *
 * Returns props to spread onto any element wearing `.spotlight` (see
 * `globals.css`): a ref and a pointer handler that write the cursor's position
 * into `--mx`/`--my` as percentages, which the class's radial gradient reads.
 *
 * Three deliberate choices, all of them about cost:
 *
 *   **No React state.** The position is written straight to the element's
 *   inline style. A `useState` here would re-render the component on every
 *   pointer move — for a KPI strip that is three subtrees re-rendering at
 *   120Hz to move a gradient the user is not looking at.
 *
 *   **One write per frame.** Pointer events fire faster than the display
 *   refreshes on most hardware, so the handler stores the latest position and
 *   a single `requestAnimationFrame` applies it. Everything in between is
 *   dropped, which is exactly right — nobody can see a highlight that was
 *   painted and replaced within 8ms.
 *
 *   **`onPointerMove`, not `mousemove` on the document.** The listener lives
 *   on the element and only exists while React has it mounted, so a screen
 *   with no lit surfaces has no pointer listeners at all. It also covers pen
 *   input for free, and touch never fires a hover state so phones do nothing.
 *
 * The effect itself fades in on `:hover` in CSS, so an element that has never
 * been pointed at is not merely transparent — it is painting nothing.
 */
export function useSpotlight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const frame = useRef<number | null>(null);
  const next = useRef({ x: 50, y: 50 });

  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    const element = ref.current;
    if (!element) return;

    const box = element.getBoundingClientRect();
    next.current = {
      x: ((event.clientX - box.left) / box.width) * 100,
      y: ((event.clientY - box.top) / box.height) * 100,
    };

    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const target = ref.current;
      if (!target) return;
      target.style.setProperty("--mx", `${next.current.x}%`);
      target.style.setProperty("--my", `${next.current.y}%`);
    });
  }, []);

  return { ref, onPointerMove };
}
