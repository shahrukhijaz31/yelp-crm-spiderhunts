"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { CalendarDays } from "lucide-react";

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
  const reduced = useReducedMotion();
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header>
        <h1 className="page-title">Meetings</h1>
        <p className="mt-2 page-intro">
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

      {/* The two facts about today, on one line. Text on the page rather than
          a tinted callout box: a banner every single morning stops being read
          by the second week, and neither of these is a warning. */}
      {(counts.today > 0 || withRecordings > 0) && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-3">
          {counts.today > 0 && (
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${openToday > 0 ? "bg-accent" : "bg-success"}`}
              />
              <span>
                <span
                  className={`tnum font-mono font-medium ${openToday > 0 ? "text-accent" : "text-fg-2"}`}
                >
                  {openToday}
                </span>{" "}
                still to run today
                {doneToday > 0 && (
                  <>
                    {" · "}
                    <span className="tnum font-mono">{doneToday}</span> already done
                  </>
                )}
              </span>
            </span>
          )}

          {/* How many meetings have audio to listen to. For an admin that is
              the point of the screen — it is where you find the calls to hear
              before walking into the next one. */}
          {counts.today > 0 && withRecordings > 0 && (
            <span aria-hidden="true" className="text-fg-4">·</span>
          )}
          {withRecordings > 0 && (
            <span>
              <span className="tnum font-mono font-medium text-fg-2">
                {withRecordings}
              </span>{" "}
              with a recording
              {role === "ADMIN" ? "" : " you uploaded"}
            </span>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* The same segmented control as the worklist, travelling pill and
            all. Two screens switching scope the same way is most of what
            makes an app feel like one product. `LayoutGroup` scopes the id so
            this control and the worklist's never try to animate into each
            other across a navigation. */}
        <LayoutGroup id="meeting-buckets">
          <div role="tablist" aria-label="Meeting timeframes" className="segmented">
            {MEETING_BUCKETS.map((candidate) => {
              const active = candidate === bucket;
              return (
                <button
                  key={candidate}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  data-active={active}
                  onClick={() => setBucket(candidate)}
                  className="segment relative"
                >
                  {active && (
                    <motion.span
                      aria-hidden="true"
                      layoutId="meeting-bucket-pill"
                      className="segment-pill"
                      transition={
                        reduced
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 420, damping: 34, mass: 0.7 }
                      }
                    />
                  )}
                  <span className="relative z-10">
                    {MEETING_BUCKET_LABELS[candidate]}
                  </span>
                  <span className="segment-count tnum relative z-10">
                    {counts[candidate]}
                  </span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
        <p className="text-caption text-fg-3">{MEETING_BUCKET_HINTS[bucket]}</p>
      </div>

      {shown.length === 0 ? (
        <div className="panel px-4 py-14 text-center">
          <span
            aria-hidden="true"
            className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-recessed text-fg-4"
          >
            <CalendarDays className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <p className="text-ui text-fg-3">
            {bucket === "unscheduled"
              ? "Every interested lead has a date booked."
              : `Nothing ${MEETING_BUCKET_LABELS[bucket].toLowerCase()}.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {days.map((day) => (
            <section key={day.date ?? "unscheduled"}>
              {/* The date is a heading *above* the panel, not a row inside it,
                  so a long agenda reads as a stack of days rather than as one
                  undifferentiated list with occasional labels in it. */}
              <h2 className="mb-2 px-1 text-caption font-medium text-fg-2">
                {day.date ? formatMeetingDay(day.date, today) : "No date booked"}
              </h2>
              {/* One panel per day, rows divided by hairlines. */}
              <div className="panel divide-y divide-line overflow-hidden">
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
