"use client";

import { useState } from "react";

import RecordingCell from "./RecordingCell";
import { formatMeetingTime, type Meeting } from "@/lib/meetings";
import type { RecordingSummary } from "@/lib/recordingRules";
import {
  CALL_STATUS_DOTS,
  CALL_STATUS_SHORT_LABELS,
  CALL_STATUS_STYLES,
  type LeadEditableFields,
} from "@/lib/types";

/**
 * One booked call. Reschedule and complete are single deliberate clicks; the
 * detail fields (time, attendees, notes) open an editor with explicit Save and
 * Cancel, matching how the worklist stages status and notes edits.
 *
 * The call recording is a field on this card, not a feature beside it: one row
 * under the meeting detail that is either a player or an upload button. It sits
 * below the fold of the card's main row so the agenda still scans on time,
 * name and status the way it always did.
 */
export default function MeetingCard({
  meeting,
  today,
  onUpdate,
  recording,
  onRecordingSaved,
  onRecordingDeleted,
}: {
  meeting: Meeting;
  today: string;
  onUpdate: (id: string, changes: Partial<LeadEditableFields>) => void;
  /** null when there is none, or when it belongs to another agent. */
  recording: RecordingSummary | null;
  onRecordingSaved: (recording: RecordingSummary) => void;
  onRecordingDeleted: (leadId: string) => void;
}) {
  const { lead, completed } = meeting;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    meetingTime: lead.meetingTime ?? "",
    meetingAttendees: lead.meetingAttendees ?? "",
    meetingNotes: lead.meetingNotes,
  });

  function openEditor() {
    setDraft({
      meetingTime: lead.meetingTime ?? "",
      meetingAttendees: lead.meetingAttendees ?? "",
      meetingNotes: lead.meetingNotes,
    });
    setEditing(true);
  }

  function save() {
    onUpdate(lead.id, {
      meetingTime: draft.meetingTime || null,
      meetingAttendees: draft.meetingAttendees.trim() || null,
      meetingNotes: draft.meetingNotes,
    });
    setEditing(false);
  }

  const overdue = !completed && meeting.bucket === "past";

  return (
    <article
      // Three states, three weights of surface. A completed meeting recedes
      // (no shadow, dimmed fill — it is history); an open one sits on the page
      // at normal elevation; one that has run past its time keeps the same
      // elevation but warms its border and catches a little accent light down
      // the left edge, which is where the eye enters the card.
      // The hover shadow restates the inset highlight rather than using
      // `shadow-e3` alone: a utility replaces the whole `box-shadow`, and
      // `.panel`'s 1px of light along the top edge is part of that stack, so
      // the card would go flat at exactly the moment it should look raised.
      className={`panel px-4 py-3 transition-[box-shadow,border-color] duration-200 hover:shadow-[inset_0_1px_0_0_var(--c-highlight),var(--c-shadow-3)] ${
        completed
          ? "opacity-75 shadow-none"
          : overdue
            ? "border-accent/40 shadow-[inset_3px_0_0_0_var(--c-accent),inset_0_1px_0_0_var(--c-highlight),var(--c-shadow-2)] hover:shadow-[inset_3px_0_0_0_var(--c-accent),inset_0_1px_0_0_var(--c-highlight),var(--c-shadow-3)]"
            : ""
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {/* Time rail — the first thing scanned down a day's list. */}
        <div className="w-20 shrink-0">
          {meeting.time ? (
            <span
              className={`tnum block font-mono text-[17px] font-semibold leading-tight tracking-[-0.01em] ${
                completed ? "text-fg-3" : "text-fg"
              }`}
            >
              {formatMeetingTime(meeting.time)}
            </span>
          ) : (
            <span className="block text-caption text-fg-3">No time</span>
          )}
          {overdue && (
            <span className="mt-1 inline-flex items-center gap-1 rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-2">
              Not done
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={`text-cell font-semibold ${completed ? "text-fg-3" : "text-fg"}`}
            >
              {lead.name}
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-caption font-medium ring-1 ring-inset ${CALL_STATUS_STYLES[lead.status]}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full shadow-[0_0_5px_-0.5px_currentColor] ${
                  lead.status === "do_not_call" ? "bg-surface" : CALL_STATUS_DOTS[lead.status]
                }`}
              />
              {CALL_STATUS_SHORT_LABELS[lead.status]}
            </span>
            {completed && (
              <span className="inline-flex items-center gap-1 rounded-md bg-st-green-bg px-2 py-0.5 text-caption font-medium text-st-green ring-1 ring-inset ring-st-green-line">
                <CheckIcon />
                Done
              </span>
            )}
          </div>

          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-fg-3">
            <span className="tnum font-mono text-num font-medium text-fg">{lead.phone}</span>
            {lead.address && <span className="truncate">{lead.address}</span>}
          </p>

          {!editing && (
            <>
              {lead.meetingAttendees && (
                <p className="mt-1.5 text-ui text-fg-2">
                  <span className="text-fg-3">With </span>
                  {lead.meetingAttendees}
                </p>
              )}
              {lead.meetingNotes && (
                <p className="mt-1 whitespace-pre-line text-ui leading-relaxed text-fg-2">
                  {lead.meetingNotes}
                </p>
              )}
            </>
          )}
        </div>

        {!editing && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* Reschedule: a date picker is already a deliberate action, so it
                commits on change like the worklist's callback cell. */}
            <label className="flex items-center gap-1.5">
              <span className="sr-only">Reschedule {lead.name}</span>
              <input
                type="date"
                aria-label={`Reschedule ${lead.name}`}
                value={lead.callbackDate ?? ""}
                onChange={(event) =>
                  onUpdate(lead.id, { callbackDate: event.target.value || null })
                }
                className="h-9 rounded-lg border border-transparent bg-transparent px-2 text-ui text-fg-2 outline-none transition-colors hover:border-line-2 hover:bg-recessed hover:text-fg focus:border-accent focus:bg-recessed focus:text-fg focus:ring-2 focus:ring-accent/25"
              />
            </label>

            <button
              type="button"
              onClick={openEditor}
              // No `bg-surface` here: a background utility sits in Tailwind's
              // utilities layer and would outrank `.ui-btn-secondary:hover`,
              // killing the hover. The card is already on surface anyway.
              className="ui-btn ui-btn-secondary h-9"
            >
              Details
            </button>

            {completed ? (
              <button
                type="button"
                onClick={() => onUpdate(lead.id, { meetingCompletedAt: null })}
                className="ui-btn h-9 font-normal text-fg-3 underline decoration-line-2 underline-offset-4 hover:text-fg"
              >
                Reopen
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onUpdate(lead.id, { meetingCompletedAt: today })}
                className="ui-btn h-9 border border-accent/50 text-accent hover:bg-accent hover:text-on-accent"
              >
                <CheckIcon />
                Complete
              </button>
            )}
          </div>
        )}
      </div>

      <RecordingCell
        leadId={lead.id}
        leadName={lead.name}
        recording={recording}
        onSaved={onRecordingSaved}
        onDeleted={onRecordingDeleted}
      />

      {editing && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="grid gap-3 sm:grid-cols-[130px_minmax(0,1fr)]">
            <label className="flex flex-col gap-1">
              <span className="eyebrow">Time</span>
              <input
                type="time"
                value={draft.meetingTime}
                onChange={(event) =>
                  setDraft({ ...draft, meetingTime: event.target.value })
                }
                className="ui-field h-9"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="eyebrow">Attendees</span>
              <input
                type="text"
                value={draft.meetingAttendees}
                onChange={(event) =>
                  setDraft({ ...draft, meetingAttendees: event.target.value })
                }
                placeholder="Who is joining, and in what capacity"
                className="ui-field h-9"
              />
            </label>
          </div>

          <label className="mt-3 flex flex-col gap-1">
            <span className="eyebrow">Meeting notes</span>
            <textarea
              value={draft.meetingNotes}
              onChange={(event) =>
                setDraft({ ...draft, meetingNotes: event.target.value })
              }
              rows={3}
              placeholder="Agenda, what to bring, what was agreed…"
              className="ui-field h-auto w-full resize-y p-2.5 leading-relaxed"
            />
            <span className="text-meta text-fg-3">
              Separate from the call notes on the worklist.
            </span>
          </label>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              className="ui-btn ui-btn-primary h-9"
            >
              Save details
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="ui-btn h-9 text-fg-3 hover:bg-hover hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path
        d="M2.5 6.3 4.8 8.6 9.5 3.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
