"use client";

import { useEffect, useRef, useState } from "react";

import { CALL_STATUS_LABELS, type Lead, type LeadEditableFields } from "@/lib/types";

/**
 * Book — or re-book — a meeting from the worklist.
 *
 * Why a dialog and not a popover anchored to the cell: the table lives inside
 * an `overflow-auto` container, and anything absolutely positioned inside a
 * row is clipped by it. A fixed-position panel is outside that box, so it
 * cannot be cut in half by the column it belongs to.
 *
 * The one rule worth knowing is about status, and it is stated on the form
 * rather than left to be discovered:
 *
 *   date only        a call-back. Status is not touched — "ring them Tuesday"
 *                    is not a claim that they are interested.
 *   date + time      a meeting. The lead is marked Called - Interested,
 *                    because that is what the Meetings view means by a booked
 *                    call, and a meeting with no interest behind it is a
 *                    booking somebody will not understand tomorrow.
 *
 * Either way the lead appears in Meetings, since membership there is derived
 * from exactly these two fields (`isMeetingLead`).
 */
export default function BookMeetingDialog({
  lead,
  onSave,
  onClose,
}: {
  lead: Lead;
  onSave: (changes: Partial<LeadEditableFields>) => void;
  onClose: () => void;
}) {
  const [date, setDate] = useState(lead.callbackDate ?? "");
  const [time, setTime] = useState(lead.meetingTime ?? "");
  const [attendees, setAttendees] = useState(lead.meetingAttendees ?? "");
  const dateRef = useRef<HTMLInputElement>(null);

  const existing = lead.callbackDate !== null;

  // Focus the field the agent came here to fill. Without this the dialog opens
  // with focus still on the row behind it, so Escape works but nothing else
  // does until they reach for the mouse again.
  useEffect(() => {
    dateRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!date) return;

    const changes: Partial<LeadEditableFields> = {
      callbackDate: date,
      meetingTime: time || null,
      meetingAttendees: attendees.trim() || null,
    };

    // Only ever an upgrade, and only when a time makes it a meeting. Writing
    // the status unconditionally would quietly overwrite a deliberate "Do not
    // call" the moment somebody booked a follow-up against the wrong row.
    if (time && lead.status !== "interested") changes.status = "interested";

    onSave(changes);
    onClose();
  }

  function clear() {
    onSave({ callbackDate: null, meetingTime: null, meetingAttendees: null });
    onClose();
  }

  return (
    <div
      // Fixed, so the table's own scroll container has no say in where this
      // lands or whether it is clipped.
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Book a meeting with ${lead.name}`}
    >
      {/* A click outside is a cancel — the same thing Escape does. */}
      <button
        type="button"
        aria-label="Cancel"
        onClick={onClose}
        // Blurred as well as darkened. A scrim that only dims still leaves the
        // eight-column table behind it perfectly legible, and a modal you can
        // read through is a modal people try to interact through.
        className="absolute inset-0 cursor-default bg-base/60 backdrop-blur-[3px]"
      />

      <form
        onSubmit={submit}
        className="panel-float pop-in relative w-full max-w-sm p-4 [--pop-origin:center]"
      >
        <h2 className="text-cell font-medium tracking-[-0.015em] text-fg">
          {existing ? "Meeting" : "Book a meeting"}
        </h2>
        <p className="mt-1 truncate text-caption text-fg-3" title={lead.name}>
          {lead.name}
          {lead.phone && (
            <span className="tnum font-mono text-fg-2"> · {lead.phone}</span>
          )}
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
          <label className="flex flex-col gap-1">
            <span className="field-label">Date</span>
            <input
              ref={dateRef}
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="ui-field"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="field-label">Time</span>
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="ui-field"
            />
          </label>
        </div>

        <label className="mt-3 flex flex-col gap-1">
          <span className="field-label">With</span>
          <input
            type="text"
            value={attendees}
            onChange={(event) => setAttendees(event.target.value)}
            placeholder="Who is joining, and in what capacity"
            className="ui-field w-full"
          />
        </label>

        <p className="mt-2.5 text-meta leading-relaxed text-fg-4">
          {time ? (
            <>
              Books a meeting and marks this lead{" "}
              <span className="text-fg-2">{CALL_STATUS_LABELS.interested}</span>.
            </>
          ) : (
            <>
              A date on its own is a call-back — the status is left alone. Add a
              time to book it as a meeting.
            </>
          )}{" "}
          Either way it appears under Meetings, where the agenda notes live.
        </p>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={!date} className="ui-btn ui-btn-primary h-9">
            {existing ? "Save" : "Book meeting"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ui-btn ui-btn-ghost h-9"
          >
            Cancel
          </button>
          {existing && (
            <button
              type="button"
              onClick={clear}
              className="ui-btn ui-btn-ghost ml-auto h-9 px-2.5 hover:text-danger"
            >
              Remove
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
