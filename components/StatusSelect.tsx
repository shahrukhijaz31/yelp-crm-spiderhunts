"use client";

import {
  CALL_STATUSES,
  CALL_STATUS_DOTS,
  CALL_STATUS_LABELS,
  CALL_STATUS_SHORT_LABELS,
  CALL_STATUS_STYLES,
  type CallStatus,
} from "@/lib/types";

/**
 * Visual language: **a control.** Filled chip, small radius, leading status dot
 * and a trailing chevron — it is meant to read as something you press, which is
 * what separates it at a glance from a warning flag (unfilled annotation) and a
 * callback date (mono text on a stripe).
 *
 * A native `<select>` sits transparently on top, so changing status stays one
 * click with no custom keyboard handling to get wrong.
 *
 * Choosing a value *stages* it — `pending` marks the chip with a gold outline
 * until the row's Save button commits it.
 */
export default function StatusSelect({
  value,
  pending = false,
  onChange,
}: {
  value: CallStatus;
  pending?: boolean;
  onChange: (status: CallStatus) => void;
}) {
  return (
    // Full width of the cell, not shrink-to-fit: a column of chips that all
    // start and end in the same place can be read straight down, where ragged
    // ones have to be read one at a time.
    <div className="group relative flex w-full">
      {/* `group-focus-within` on the chip: the real <select> is transparent and
          stacked on top, so a focus ring drawn on it would be invisible. */}
      <span
        className={`pointer-events-none inline-flex w-full items-center gap-2 rounded-md py-1.5 pl-2.5 pr-2 text-ui font-medium ring-1 ring-inset transition-shadow group-hover:ring-2 group-focus-within:ring-2 group-focus-within:ring-accent ${
          CALL_STATUS_STYLES[value]
        } ${pending ? "outline outline-1 outline-offset-2 outline-st-gold" : ""}`}
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${
            value === "do_not_call" ? "bg-surface" : CALL_STATUS_DOTS[value]
          }`}
        />
        <span className="truncate">{CALL_STATUS_SHORT_LABELS[value]}</span>
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
        >
          <path
            d="M2.5 4.75 6 8.25 9.5 4.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <select
        value={value}
        aria-label="Call status"
        onChange={(event) => onChange(event.target.value as CallStatus)}
        className="absolute inset-0 w-full cursor-pointer opacity-0"
      >
        {CALL_STATUSES.map((status) => (
          <option key={status} value={status}>
            {CALL_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    </div>
  );
}