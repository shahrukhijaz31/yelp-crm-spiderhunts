"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";

import {
  CALL_STATUSES,
  CALL_STATUS_DOTS,
  CALL_STATUS_LABELS,
  CALL_STATUS_STYLES,
  type CallStatus,
} from "@/lib/types";

/**
 * The workspace's status control.
 *
 * The worklist's `StatusSelect` is a native `<select>` wearing a chip, and that
 * is the right answer inside a table row: it is one line tall, it opens the
 * platform's own list, and thirty of them cost nothing. It is the wrong answer
 * here. This is the single most consequential control on the screen — the whole
 * page exists so an agent can record what happened on the call — and a native
 * dropdown renders eight identical lines of grey system text with no room for
 * the colour that carries the meaning everywhere else in the app.
 *
 * So this one is drawn: a full-width trigger wearing the status's own hue, and
 * a listbox where every option carries its dot. The colour vocabulary is
 * `lib/types.ts`'s, unchanged and imported rather than restated, so a status
 * looks the same here as it does in a row, on a meeting card and in the stat
 * legend.
 *
 * **The options and the values are exactly the worklist's.** `CALL_STATUSES` in
 * declaration order, `CALL_STATUS_LABELS` for the text. Nothing about what a
 * status *means* lives in this file — it draws a closed set it is handed.
 *
 * Choosing a value **stages** it. Same rule as the row: nothing is written
 * until the agent presses Save, and `pending` marks the trigger until they do.
 *
 * Written by hand rather than reached for from a library because the behaviour
 * a listbox owes is short and worth stating: roles and `aria-activedescendant`
 * for assistive tech, arrows/Home/End to move, Enter and Space to choose,
 * Escape and a click outside to abandon, and focus returned to the trigger
 * whichever way it closes.
 */
export default function StatusPicker({
  value,
  committed,
  onChange,
}: {
  /** The staged value — what the control shows. */
  value: CallStatus;
  /** What is actually saved. Shown as "was …" while the two differ. */
  committed: CallStatus;
  onChange: (status: CallStatus) => void;
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  // Which option the keyboard is on. Seeded from the current value so opening
  // with the keyboard starts on the status the lead already has.
  const [active, setActive] = useState(() => CALL_STATUSES.indexOf(value));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const pending = value !== committed;

  // A click anywhere else is an abandon, and so is a scroll of the page behind
  // an open list — both are the agent's attention leaving this control.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  function openList() {
    setActive(Math.max(0, CALL_STATUSES.indexOf(value)));
    setOpen(true);
  }

  function close({ refocus = true }: { refocus?: boolean } = {}) {
    setOpen(false);
    // The trigger is where focus came from and where a keyboard user expects to
    // be afterwards — without this, Escape drops focus onto the document body
    // and the next Tab starts again from the top of the page.
    if (refocus) triggerRef.current?.focus();
  }

  function choose(status: CallStatus) {
    onChange(status);
    close();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openList();
      }
      return;
    }

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        // Not `preventDefault` — Tab should still move on, it just must not
        // leave an open list floating behind it.
        close({ refocus: false });
        break;
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(CALL_STATUSES.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(CALL_STATUSES.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const status = CALL_STATUSES[active];
        if (status) choose(status);
        break;
      }
      default:
        break;
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Call status: ${CALL_STATUS_LABELS[value]}`}
        onClick={() => (open ? close({ refocus: false }) : openList())}
        className={`status-trigger ${CALL_STATUS_STYLES[value]} ${
          pending ? "status-trigger-pending" : ""
        }`}
      >
        <span aria-hidden="true" className="chip-dot" />
        <span className="min-w-0 flex-1 truncate text-left">
          {CALL_STATUS_LABELS[value]}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 opacity-60 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            aria-label="Call status"
            aria-activedescendant={`status-option-${CALL_STATUSES[active] ?? value}`}
            tabIndex={-1}
            initial={reduced ? false : { opacity: 0, y: -4, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 0.61, 0.36, 1] }}
            className="panel-float absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-[19rem] overflow-y-auto p-1"
          >
            {CALL_STATUSES.map((status, index) => {
              const selected = status === value;
              return (
                <li key={status}>
                  <button
                    id={`status-option-${status}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    // Pointer and keyboard agree on which row is highlighted:
                    // moving the mouse moves the keyboard cursor too, so the
                    // two can never be lit at once on different options.
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(status)}
                    className={`status-option ${index === active ? "status-option-active" : ""}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${CALL_STATUS_DOTS[status]}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {CALL_STATUS_LABELS[status]}
                    </span>
                    {selected && (
                      <Check
                        className="h-3.5 w-3.5 shrink-0 text-accent"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
