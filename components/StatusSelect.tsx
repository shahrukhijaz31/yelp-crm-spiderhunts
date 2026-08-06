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
    <div className="group relative inline-flex">
      <span
        className={`pointer-events-none inline-flex w-full items-center gap-1.5 rounded-[5px] py-1.5 pl-2 pr-1.5 text-[12px] font-medium ring-1 ring-inset transition-shadow group-hover:ring-2 ${CALL_STATUS_STYLES[value]} ${
          pending ? "outline outline-1 outline-offset-2 outline-st-gold" : ""
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            value === "do_not_call" ? "bg-surface" : CALL_STATUS_DOTS[value]
          }`}
        />
        <span className="whitespace-nowrap">
          {CALL_STATUS_SHORT_LABELS[value]}
        </span>
        <svg viewBox="0 0 12 12" className="ml-auto h-3 w-3 shrink-0 opacity-45">
          <path
            d="M2.5 4.75 6 8.25 9.5 4.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <select
        value={value}
        aria-label="Call status"
        onChange={(event) => onChange(event.target.value as CallStatus)}
        className="absolute inset-0 cursor-pointer opacity-0"
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