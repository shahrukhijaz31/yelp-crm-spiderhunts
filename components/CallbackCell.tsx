"use client";

import { useState } from "react";
import { CalendarDays, CalendarPlus, X } from "lucide-react";

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
/**
 * Four states, and the difference between them is carried by *fill* rather
 * than by four colours.
 *
 *   overdue   a filled accent chip — the only red fill in a table row, and the
 *             one thing here that should stop an agent scrolling past
 *   today     accent text on a soft accent tint, one step quieter
 *   future    plain text; a date in the diary is information, not a warning
 *   none      the quietest thing in the row, and an invitation to click
 *
 * One hue, four intensities. Using a second colour for "overdue" would put it
 * in competition with the status pill two columns to the left, which is
 * already carrying six colours of its own.
 */
const STATE = {
  overdue: {
    text: "text-on-accent",
    icon: "text-on-accent",
    fill: "bg-accent-solid border-transparent",
  },
  today: {
    text: "text-accent",
    icon: "text-accent",
    fill: "bg-accent-soft border-accent-line",
  },
  future: {
    text: "text-fg-2",
    icon: "text-fg-4",
    fill: "bg-transparent border-transparent",
  },
  none: {
    text: "text-fg-3",
    icon: "text-fg-4",
    fill: "bg-transparent border-transparent",
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
        className={`inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${tone.fill} ${
          !lead.callbackDate ? "hover:border-line-2 hover:bg-hover" : ""
        }`}
      >
        {lead.callbackDate ? (
          <>
            <CalendarDays
              className={`h-3.5 w-3.5 shrink-0 ${tone.icon}`}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span
              className={`tnum min-w-0 truncate font-mono text-caption font-medium ${tone.text}`}
            >
              {formatCallbackDate(lead.callbackDate, today)}
              {/* The booked time, where there is one. Without it an agent had
                  to open Meetings to find out whether a date was a call-back
                  or a 2pm appointment. */}
              {lead.meetingTime && (
                <span className={state === "overdue" ? "opacity-80" : "text-fg-3"}>
                  {" "}
                  {formatMeetingTime(lead.meetingTime)}
                </span>
              )}
            </span>
          </>
        ) : (
          // Names the action rather than the absence. "No callback" was
          // accurate and told an agent nothing about what to do with the cell —
          // which, since this cell is how a meeting gets booked at all, was the
          // one thing it needed to say.
          <>
            <CalendarPlus
              className="h-3.5 w-3.5 shrink-0 text-fg-4"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span className="whitespace-nowrap text-caption text-fg-3 transition-colors group-hover/cb:text-fg-2">
              Book…
            </span>
          </>
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
          className="ml-0.5 shrink-0 rounded p-1 leading-none text-fg-4 opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/cb:opacity-100 group-focus-within/cb:opacity-100"
        >
          <X className="h-3 w-3" strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
