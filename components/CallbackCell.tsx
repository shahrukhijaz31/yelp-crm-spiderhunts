"use client";

import { useState } from "react";

import BookMeetingDialog from "./BookMeetingDialog";
import { callbackState, formatCallbackDate } from "@/lib/leadUtils";
import { formatMeetingTime } from "@/lib/meetings";
import type { Lead, LeadEditableFields } from "@/lib/types";

/**
 * Visual language: **a date, not a pill.** Monospaced numerals behind a 2px
 * vertical stripe — a shape unlike both the filled status chip and the
 * unfilled warning flag.
 *
 * Urgency is carried by weight rather than a second hue, since red is spoken
 * for: due today is accent text on bare surface, overdue is the same red but
 * *filled*, with a `late` tag. One colour, two clearly different intensities.
 *
 * This cell used to be a bare `<input type="date">` at `opacity-0`, laid over
 * the styled date so the native control could do the work invisibly. It could
 * not: Chrome and Edge stopped opening the picker when the body of a date
 * field is clicked (only the calendar indicator does it, and that indicator
 * was one of the invisible parts). The cell took focus, looked identical, and
 * did nothing — the date could only be typed in blind. It also meant the
 * column that silently decides what appears under Meetings offered no way to
 * say *when* the meeting is.
 *
 * So the cell opens a small dialog instead. Date alone is still one field and
 * one click; a time turns it into a booked meeting.
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
  /** Commits immediately, like the date always did — this is not a staged edit. */
  onChange: (changes: Partial<LeadEditableFields>) => void;
}) {
  const state = callbackState(lead, today);
  const tone = STATE[state];
  const [booking, setBooking] = useState(false);

  return (
    <div className="group/cb flex items-center">
      {booking && (
        <BookMeetingDialog
          lead={lead}
          onSave={onChange}
          onClose={() => setBooking(false)}
        />
      )}
      <button
        type="button"
        onClick={() => setBooking(true)}
        title={
          lead.callbackDate
            ? "Change the date, add a time, or remove it"
            : "Pick a date to ring back, or add a time to book a meeting"
        }
        aria-label={
          lead.callbackDate
            ? `Meeting for ${lead.name}: ${formatCallbackDate(lead.callbackDate, today)}${
                lead.meetingTime ? ` at ${lead.meetingTime}` : ""
              }. Change it`
            : `Book a meeting or a call-back for ${lead.name}`
        }
        className={`inline-flex cursor-pointer items-stretch overflow-hidden rounded-r text-left transition-colors ${tone.fill}`}
      >
        <span aria-hidden="true" className={`w-[2px] shrink-0 ${tone.stripe}`} />
        {lead.callbackDate ? (
          <span className="inline-flex items-center gap-1.5 py-1.5 pl-2 pr-1.5">
            <CalendarIcon className={tone.icon} />
            <span
              className={`tnum whitespace-nowrap font-mono text-caption font-semibold ${tone.text}`}
            >
              {formatCallbackDate(lead.callbackDate, today)}
              {/* The booked time, where there is one. The worklist never showed
                  it before, so an agent had to open Meetings to find out
                  whether a date was a call-back or a 2pm appointment. */}
              {lead.meetingTime && (
                <span className="font-medium text-fg-3">
                  {" "}
                  {formatMeetingTime(lead.meetingTime)}
                </span>
              )}
            </span>
            {state === "overdue" && (
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-accent-2">
                late
              </span>
            )}
          </span>
        ) : (
          // Names the action rather than the absence. "No callback" was
          // accurate and told an agent nothing about what to do with the cell —
          // which, since this cell is how a meeting gets booked at all, was the
          // one thing it needed to say.
          <span className="inline-flex items-center gap-1.5 py-1.5 pl-2 pr-2 text-fg-3 transition-colors group-hover/cb:text-fg">
            <CalendarIcon className="" />
            <span className="whitespace-nowrap text-caption">Book…</span>
          </span>
        )}
      </button>

      {lead.callbackDate && (
        <button
          type="button"
          // Clears the meeting detail with the date. Leaving a time and an
          // attendee list behind on a lead with no date would have them
          // reappear, silently attached, the next time anyone booked one.
          onClick={() =>
            onChange({ callbackDate: null, meetingTime: null, meetingAttendees: null })
          }
          aria-label={`Clear the date for ${lead.name}`}
          title="Clear the date"
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