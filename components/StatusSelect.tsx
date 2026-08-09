"use client";

import { ChevronDown } from "lucide-react";

import {
  CALL_STATUSES,
  CALL_STATUS_LABELS,
  CALL_STATUS_SHORT_LABELS,
  CALL_STATUS_STYLES,
  type CallStatus,
} from "@/lib/types";

/**
 * Visual language: **a control**. A tinted pill with a leading status dot and a
 * trailing chevron — meant to read as something you press, which is what
 * separates it at a glance from a warning flag (unfilled annotation) and a
 * callback date (mono text behind a stripe).
 *
 * A native `<select>` sits transparently on top, so changing status stays one
 * click, keyboard support is the platform's, and there is no custom listbox to
 * get wrong. The visible pill is `pointer-events: none` and purely a costume.
 *
 * The chevron only appears on hover and focus. Six of these down a column, each
 * permanently wearing a dropdown arrow, is six pieces of chrome competing with
 * six pieces of information; the pill shape already says it is interactive, and
 * the arrow is there the moment anyone reaches for it.
 *
 * Choosing a value *stages* it — `pending` marks the chip until the row's Save
 * button commits it.
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
    // Full width of the cell, not shrink-to-fit: a column of pills that all
    // start and end in the same place can be read straight down, where ragged
    // ones have to be read one at a time.
    <div className="group relative flex w-full">
      {/* `group-focus-within` on the pill: the real <select> is transparent and
          stacked on top, so a focus ring drawn on it would be invisible. */}
      <span
        className={`chip pointer-events-none w-full justify-start border py-1 pl-2 pr-1.5 transition-colors group-hover:brightness-[1.08] group-focus-within:outline group-focus-within:outline-2 group-focus-within:outline-offset-2 group-focus-within:outline-[var(--c-focus)] ${
          CALL_STATUS_STYLES[value]
        } ${pending ? "ring-1 ring-warning ring-offset-1 ring-offset-surface" : ""}`}
      >
        <span aria-hidden="true" className="chip-dot" />
        <span className="truncate">{CALL_STATUS_SHORT_LABELS[value]}</span>
        <ChevronDown
          className="ml-auto h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-within:opacity-60"
          strokeWidth={2}
          aria-hidden="true"
        />
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

/**
 * Re-exported so `MeetingCard` and anything else showing a *static* status can
 * draw the identical pill without the select machinery underneath it. One
 * definition, so a status can never look like two different things.
 */
export function StatusChip({ status }: { status: CallStatus }) {
  return (
    <span className={`chip border ${CALL_STATUS_STYLES[status]}`}>
      <span aria-hidden="true" className="chip-dot" />
      {CALL_STATUS_SHORT_LABELS[status]}
    </span>
  );
}
