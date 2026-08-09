"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";

import MeetingCard from "./MeetingCard";
import { useLeads } from "./LeadsProvider";
import type { Role } from "@/lib/access";
import type { RecordingSummary } from "@/lib/recordingRules";
import {
  collectMeetings,
  countByBucket,
  formatMeetingDay,
  groupByDay,
  inBucket,
  MEETING_BUCKETS,
  MEETING_BUCKET_HINTS,
  MEETING_BUCKET_LABELS,
  type MeetingBucket,
} from "@/lib/meetings";

/**
 * The Meetings view: an agenda of booked calls, grouped by day.
 *
 * An agenda rather than a month grid — a cold-calling day is read in time
 * order, and a grid would spend most of its pixels on empty squares while
 * hiding the detail (attendees, notes) that decides how the call opens.
 *
 * Nothing here owns a list of meetings. Membership is computed from the leads
 * on every render, so a status change made on the worklist shows up here
 * immediately and disappears again if it is undone.
 *
 * Call recordings are the exception, and only because they are not derivable
 * from a lead: they arrive as a map keyed by meeting, read once on the server
 * with the caller's permissions already applied (`listRecordingsFor`), so a
 * card never has to ask whether it may show a player — if a recording is in
 * the map, this user may hear it.
 */
export default function MeetingsPanel({
  role,
  initialRecordings,
}: {
  role: Role;
  /** Keyed by lead id. Admins get every recording; agents get their own. */
  initialRecordings: Record<string, RecordingSummary>;
}) {
  const { leads, today, updateLead } = useLeads();
  const [bucket, setBucket] = useState<MeetingBucket>("today");
  const [recordings, setRecordings] =
    useState<Record<string, RecordingSummary>>(initialRecordings);

  const onRecordingSaved = useCallback((recording: RecordingSummary) => {
    setRecordings((current) => ({ ...current, [recording.leadId]: recording }));
  }, []);

  const onRecordingDeleted = useCallback((leadId: string) => {
    setRecordings((current) => {
      const next = { ...current };
      delete next[leadId];
      return next;
    });
  }, []);

  const meetings = useMemo(() => collectMeetings(leads, today), [leads, today]);
  const counts = useMemo(() => countByBucket(meetings), [meetings]);
  const shown = useMemo(() => inBucket(meetings, bucket), [meetings, bucket]);
  const days = useMemo(() => groupByDay(shown), [shown]);

  const openToday = meetings.filter(
    (meeting) => meeting.bucket === "today" && !meeting.completed,
  ).length;
  const doneToday = counts.today - openToday;

  const withRecordings = meetings.filter(
    (meeting) => recordings[meeting.lead.id] !== undefined,
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h1 className="page-title">Meetings</h1>
        <p className="mt-3 page-intro">
          Every interested lead and everything with a date in the diary. Leads
          arrive here on their own — mark one{" "}
          <span className="text-fg-2">Called - Interested</span> on the{" "}
          <Link
            href="/"
            className="text-fg-2 underline decoration-line-2 underline-offset-4 hover:text-fg"
          >
            worklist
          </Link>
          , or give it a callback date, and it appears.
        </p>
      </header>

      {counts.today > 0 && (
        <p className="flex items-center gap-2.5 rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 text-ui text-fg shadow-e1">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_7px_0_var(--c-accent)]"
          />
          <span>
          <span className="tnum font-mono font-medium text-accent">{openToday}</span>{" "}
          still to run today
          {doneToday > 0 && (
            <span className="text-fg-3">
              {" "}
              · <span className="tnum font-mono">{doneToday}</span> already done
            </span>
          )}
          </span>
        </p>
      )}

      {/* How many of the meetings on the agenda have audio to listen to. For an
          admin that is the whole point of the screen — it is where you find the
          calls to hear before walking into the meeting — so it is stated once
          here rather than left to be discovered by scrolling. */}
      {withRecordings > 0 && (
        <p className="text-caption text-fg-3">
          <span className="tnum font-mono font-medium text-fg-2">{withRecordings}</span>{" "}
          {withRecordings === 1 ? "meeting has" : "meetings have"} a call recording
          attached
          {role === "ADMIN" ? "" : " that you uploaded"}.
        </p>
      )}

      <div>
        <div
          role="tablist"
          aria-label="Meeting timeframes"
          className="flex items-end gap-1 border-b border-line"
        >
          {MEETING_BUCKETS.map((candidate) => {
            const active = candidate === bucket;
            return (
              <button
                key={candidate}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setBucket(candidate)}
                className={`group relative flex items-center gap-2 rounded-t-lg px-3.5 pb-2.5 pt-2 text-ui transition-colors ${
                  // Matches the worklist tabs exactly: weight and ink shift
                  // together with the accent rule, so the active tab is
                  // obvious from three signals rather than one.
                  active
                    ? "bg-gradient-to-b from-transparent to-[var(--c-surface)] font-semibold text-fg"
                    : "font-medium text-fg-3 hover:bg-hover hover:text-fg-2"
                }`}
              >
                {MEETING_BUCKET_LABELS[candidate]}
                <span
                  className={`tnum rounded-md px-1.5 py-0.5 font-mono text-meta font-medium transition-colors ${
                    active
                      ? "bg-accent text-on-accent shadow-[0_2px_8px_-3px_var(--c-accent)]"
                      : "bg-rail text-fg-3 group-hover:text-fg-2"
                  }`}
                >
                  {counts[candidate]}
                </span>
                <span
                  aria-hidden="true"
                  data-active={active}
                  className="tab-rule absolute inset-x-0 -bottom-px h-[2px] bg-accent"
                />
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-caption text-fg-3">
          {MEETING_BUCKET_HINTS[bucket]}
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-2 bg-surface/60 px-4 py-12 text-center">
          <span
            aria-hidden="true"
            className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-recessed text-fg-4 shadow-e1"
          >
            <CalendarIcon />
          </span>
          <p className="text-ui text-fg-3">
            {bucket === "unscheduled"
              ? "Every interested lead has a date booked."
              : `Nothing ${MEETING_BUCKET_LABELS[bucket].toLowerCase()}.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map((day) => (
            <section key={day.date ?? "unscheduled"}>
              <h2 className="eyebrow mb-2.5 border-b border-line pb-1.5">
                {day.date ? formatMeetingDay(day.date, today) : "No date booked"}
              </h2>
              <div className="flex flex-col gap-2">
                {day.meetings.map((meeting) => (
                  <MeetingCard
                    key={meeting.lead.id}
                    meeting={meeting}
                    today={today}
                    onUpdate={updateLead}
                    recording={recordings[meeting.lead.id] ?? null}
                    onRecordingSaved={onRecordingSaved}
                    onRecordingDeleted={onRecordingDeleted}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <rect
        x="3.4"
        y="4.8"
        width="17.2"
        height="15"
        rx="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.4 9.6h17.2M8.4 2.8v3.6M15.6 2.8v3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
