"use client";

import { useState } from "react";

import { formatMeetingTime, type Meeting } from "@/lib/meetings";
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
 */
export default function MeetingCard({
  meeting,
  today,
  onUpdate,
}: {
  meeting: Meeting;
  today: string;
  onUpdate: (id: string, changes: Partial<LeadEditableFields>) => void;
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
      className={`rounded-xl border px-4 py-3 transition-colors ${
        completed
          ? "border-line bg-surface/60"
          : overdue
            ? "border-accent/40 bg-surface"
            : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {/* Time rail — the first thing scanned down a day's list. */}
        <div className="w-20 shrink-0">
          {meeting.time ? (
            <span
              className={`tnum block font-mono text-[14px] font-medium ${
                completed ? "text-fg-4" : "text-fg"
              }`}
            >
              {formatMeetingTime(meeting.time)}
            </span>
          ) : (
            <span className="block font-mono text-[13px] text-fg-4">— —</span>
          )}
          {overdue && (
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-accent-2">
              Not done
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={`text-[14px] font-semibold ${completed ? "text-fg-3" : "text-fg"}`}
            >
              {lead.name}
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${CALL_STATUS_STYLES[lead.status]}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  lead.status === "do_not_call" ? "bg-surface" : CALL_STATUS_DOTS[lead.status]
                }`}
              />
              {CALL_STATUS_SHORT_LABELS[lead.status]}
            </span>
            {completed && (
              <span className="inline-flex items-center gap-1 rounded-[5px] bg-st-green-bg px-2 py-0.5 text-[11.5px] font-medium text-st-green ring-1 ring-inset ring-st-green-line">
                <CheckIcon />
                Done
              </span>
            )}
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3">
            <span className="tnum font-mono text-fg-2">{lead.phone}</span>
            {lead.address && <span className="truncate">{lead.address}</span>}
          </p>

          {!editing && (
            <>
              {lead.meetingAttendees && (
                <p className="mt-1.5 text-[12.5px] text-fg-2">
                  <span className="text-fg-4">With </span>
                  {lead.meetingAttendees}
                </p>
              )}
              {lead.meetingNotes && (
                <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-fg-2">
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
                className="h-8 rounded-lg border border-transparent bg-transparent px-2 text-[12.5px] text-fg-3 outline-none transition-colors hover:border-line-2 hover:bg-recessed hover:text-fg focus:border-accent focus:bg-recessed focus:text-fg focus:ring-2 focus:ring-accent/25"
              />
            </label>

            <button
              type="button"
              onClick={openEditor}
              className="h-8 rounded-lg border border-line-2 bg-surface px-2.5 text-[12.5px] text-fg-2 transition-colors hover:border-fg-4 hover:text-fg"
            >
              Details
            </button>

            {completed ? (
              <button
                type="button"
                onClick={() => onUpdate(lead.id, { meetingCompletedAt: null })}
                className="h-8 rounded-lg px-2.5 text-[12.5px] text-fg-3 underline decoration-line-2 underline-offset-4 transition-colors hover:text-fg"
              >
                Reopen
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onUpdate(lead.id, { meetingCompletedAt: today })}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-accent/50 px-3 text-[12.5px] font-medium text-accent transition-colors hover:bg-accent hover:text-on-accent"
              >
                <CheckIcon />
                Complete
              </button>
            )}
          </div>
        )}
      </div>

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
                className="h-8 rounded-lg border border-line-2 bg-recessed px-2 text-[12.5px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
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
                className="h-8 rounded-lg border border-line-2 bg-recessed px-2 text-[12.5px] text-fg outline-none placeholder:text-fg-4 focus:border-accent focus:ring-2 focus:ring-accent/25"
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
              className="w-full resize-y rounded-lg border border-line-2 bg-recessed p-2 text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg-4 focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
            <span className="text-[11px] text-fg-4">
              Separate from the call notes on the worklist.
            </span>
          </label>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              className="h-8 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-2"
            >
              Save details
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="h-8 rounded-lg px-2.5 text-[12.5px] text-fg-3 transition-colors hover:text-fg"
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
