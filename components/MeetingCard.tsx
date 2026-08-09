"use client";

import { useState } from "react";

import { Check, Users } from "lucide-react";

import RecordingCell from "./RecordingCell";
import { StatusChip } from "./StatusSelect";
import { formatMeetingTime, type Meeting } from "@/lib/meetings";
import type { RecordingSummary } from "@/lib/recordingRules";
import type { LeadEditableFields } from "@/lib/types";

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
      /*
       * A row in an agenda, not a floating card.
       *
       * These live in a day group with a hairline between each, so the article
       * itself draws no border and no shadow — six bordered cards under a date
       * heading is six objects; six hairline-separated rows is one agenda. The
       * three states are carried by ink and one stripe:
       *
       *   completed  dimmed. It is history, and it should recede.
       *   overdue    a 2px accent stripe down the left edge, which is where
       *              the eye enters the row.
       *   open       nothing. Most rows are this, and most rows should be
       *              quiet.
       */
      className={`group/meeting relative px-4 py-3 transition-colors hover:bg-hover ${
        completed ? "opacity-60" : ""
      } ${overdue ? "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-accent" : ""}`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {/* Time rail — the first thing scanned down a day's list. */}
        <div className="w-[68px] shrink-0 pt-0.5">
          {meeting.time ? (
            <span
              className={`tnum block font-mono text-num font-medium tracking-[-0.02em] ${
                completed ? "text-fg-3" : "text-fg"
              }`}
            >
              {formatMeetingTime(meeting.time)}
            </span>
          ) : (
            <span className="block text-caption text-fg-4">No time</span>
          )}
          {overdue && (
            <span className="mt-1 block text-meta font-medium text-accent">
              Not done
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={`text-cell font-medium tracking-[-0.012em] ${completed ? "text-fg-3" : "text-fg"}`}
            >
              {lead.name}
            </h3>
            <StatusChip status={lead.status} />
            {completed && (
              <span className="chip border border-success-line bg-success-bg text-success">
                <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                Done
              </span>
            )}
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-fg-3">
            <span className="tnum font-mono text-fg-2">{lead.phone}</span>
            {lead.address && (
              <>
                <span aria-hidden="true" className="text-fg-4">·</span>
                <span className="truncate">{lead.address}</span>
              </>
            )}
          </p>

          {!editing && (
            <>
              {lead.meetingAttendees && (
                <p className="mt-2 flex items-start gap-1.5 text-caption text-fg-2">
                  <Users
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-4"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  {lead.meetingAttendees}
                </p>
              )}
              {lead.meetingNotes && (
                <p className="mt-1.5 whitespace-pre-line text-caption leading-relaxed text-fg-3">
                  {lead.meetingNotes}
                </p>
              )}
            </>
          )}
        </div>

        {/*
         * Actions.
         *
         * `Complete` is the one thing anybody comes to this row to do, so it is
         * the only filled button — and it is filled in the accent, which this
         * screen otherwise spends nowhere. Reschedule and Details are quiet
         * beside it, and the whole cluster only reaches full contrast when the
         * row is hovered or something inside it has focus: at rest an agenda
         * should read as a list of meetings, not as a wall of buttons.
         */}
        {!editing && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 opacity-90 transition-opacity group-hover/meeting:opacity-100">
            <label className="flex items-center">
              <span className="sr-only">Reschedule {lead.name}</span>
              <input
                type="date"
                aria-label={`Reschedule ${lead.name}`}
                value={lead.callbackDate ?? ""}
                onChange={(event) =>
                  onUpdate(lead.id, { callbackDate: event.target.value || null })
                }
                className="ui-field h-8 !border-transparent !bg-transparent px-1.5 text-caption text-fg-3 hover:!border-line-2 hover:!bg-surface hover:text-fg focus:!border-accent focus:!bg-surface focus:text-fg"
              />
            </label>

            <button
              type="button"
              onClick={openEditor}
              className="ui-btn ui-btn-ghost h-8 px-2.5 text-caption"
            >
              Details
            </button>

            {completed ? (
              <button
                type="button"
                onClick={() => onUpdate(lead.id, { meetingCompletedAt: null })}
                className="ui-btn ui-btn-ghost h-8 px-2.5 text-caption"
              >
                Reopen
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onUpdate(lead.id, { meetingCompletedAt: today })}
                className="ui-btn ui-btn-primary h-8 px-2.5 text-caption"
              >
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
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
              <span className="field-label">Time</span>
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
              <span className="field-label">Attendees</span>
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
            <span className="field-label">Meeting notes</span>
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
              className="ui-btn ui-btn-ghost h-9"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
