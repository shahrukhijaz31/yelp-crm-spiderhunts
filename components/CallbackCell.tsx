"use client";

import { callbackState, formatCallbackDate } from "@/lib/leadUtils";
import type { Lead } from "@/lib/types";

/**
 * Visual language: **a date, not a pill.** Monospaced numerals behind a 2px
 * vertical stripe — a shape unlike both the filled status chip and the
 * unfilled warning flag.
 *
 * Urgency is carried by weight rather than a second hue, since red is spoken
 * for: due today is accent text on bare surface, overdue is the same red but
 * *filled*, with a `late` tag. One colour, two clearly different intensities.
 */
const STATE = {
  overdue: {
    stripe: "bg-accent",
    text: "text-accent-2",
    icon: "text-accent-2",
    fill: "bg-accent-soft",
  },
  today: {
    stripe: "bg-accent",
    text: "text-accent",
    icon: "text-accent",
    fill: "bg-transparent",
  },
  future: {
    stripe: "bg-line-2",
    text: "text-fg-2",
    icon: "text-fg-4",
    fill: "bg-transparent",
  },
  none: {
    stripe: "bg-transparent",
    text: "text-fg-3",
    icon: "text-fg-4",
    fill: "bg-transparent",
  },
} as const;

export default function CallbackCell({
  lead,
  today,
  onChange,
}: {
  lead: Lead;
  today: string;
  onChange: (callbackDate: string | null) => void;
}) {
  const state = callbackState(lead, today);
  const tone = STATE[state];

  return (
    <div className="group/cb flex items-center">
      {/* The focus ring lives on the label for the same reason as the status
          chip's: the date input on top is transparent. */}
      <label
        className={`relative inline-flex cursor-pointer items-stretch overflow-hidden rounded-r transition-shadow focus-within:ring-2 focus-within:ring-accent ${tone.fill}`}
      >
        <span aria-hidden="true" className={`w-[2px] shrink-0 ${tone.stripe}`} />
        {lead.callbackDate ? (
          <span className="pointer-events-none inline-flex items-center gap-1.5 py-1.5 pl-2 pr-1.5">
            <CalendarIcon className={tone.icon} />
            <span
              className={`tnum whitespace-nowrap font-mono text-caption font-semibold ${tone.text}`}
            >
              {formatCallbackDate(lead.callbackDate, today)}
            </span>
            {state === "overdue" && (
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-accent-2">
                late
              </span>
            )}
          </span>
        ) : (
          // "No callback" rather than a pair of dashes. Two dashes read as a
          // rendering fault or a field that failed to load; the words say the
          // state is known and empty, and they say it at a size an agent can
          // take in from the same glance that reads the row.
          <span className="pointer-events-none inline-flex items-center gap-1.5 py-1.5 pl-2 pr-2 text-fg-3 transition-colors group-hover/cb:text-fg">
            <CalendarIcon className="" />
            <span className="whitespace-nowrap text-caption">No callback</span>
          </span>
        )}
        <input
          type="date"
          aria-label="Callback date"
          value={lead.callbackDate ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
        />
      </label>

      {lead.callbackDate && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Clear callback date"
          title="Clear callback date"
          // Revealed by keyboard focus as well as by the cursor. Hidden on
          // `opacity` alone it was reachable by Tab but invisible once there,
          // which is the worst of both.
          className="ml-0.5 rounded p-1 leading-none text-fg-3 opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/cb:opacity-100 group-focus-within/cb:opacity-100"
        >
          <CrossIcon />
        </button>
      )}
    </div>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="h-2.5 w-2.5">
      <path
        d="m2.5 2.5 5 5m0-5-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CalendarIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
      aria-hidden="true"
    >
      <rect
        x="2.25"
        y="3.25"
        width="11.5"
        height="10.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M2.25 6.5h11.5M5.5 2v2.4M10.5 2v2.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}