"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import MeetingCard from "./MeetingCard";
import { useLeads } from "./LeadsProvider";
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
 */
export default function MeetingsPanel() {
  const { leads, today, updateLead } = useLeads();
  const [bucket, setBucket] = useState<MeetingBucket>("today");

  const meetings = useMemo(() => collectMeetings(leads, today), [leads, today]);
  const counts = useMemo(() => countByBucket(meetings), [meetings]);
  const shown = useMemo(() => inBucket(meetings, bucket), [meetings, bucket]);
  const days = useMemo(() => groupByDay(shown), [shown]);

  const openToday = meetings.filter(
    (meeting) => meeting.bucket === "today" && !meeting.completed,
  ).length;
  const doneToday = counts.today - openToday;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h1 className="display-num text-[26px] leading-none text-fg">Meetings</h1>
        <p className="mt-2.5 text-[13px] leading-relaxed text-fg-3">
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
        <p className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 text-[13px] text-fg">
          <span className="tnum font-mono font-medium text-accent">{openToday}</span>{" "}
          still to run today
          {doneToday > 0 && (
            <span className="text-fg-3">
              {" "}
              · <span className="tnum font-mono">{doneToday}</span> already done
            </span>
          )}
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
                className={`group relative flex items-center gap-2 px-3.5 pb-2.5 pt-2 text-[13px] font-medium transition-colors ${
                  active ? "text-fg" : "text-fg-3 hover:text-fg-2"
                }`}
              >
                {MEETING_BUCKET_LABELS[candidate]}
                <span
                  className={`tnum rounded px-1.5 py-0.5 font-mono text-[11px] font-medium transition-colors ${
                    active
                      ? "bg-accent text-on-accent"
                      : "bg-rail text-fg-3 group-hover:text-fg-2"
                  }`}
                >
                  {counts[candidate]}
                </span>
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-0 -bottom-px h-[2px] ${
                    active ? "bg-accent" : "bg-transparent"
                  }`}
                />
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[12px] text-fg-4">
          {MEETING_BUCKET_HINTS[bucket]}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-2 bg-surface px-4 py-10 text-center text-[13px] text-fg-4">
          {bucket === "unscheduled"
            ? "Every interested lead has a date booked."
            : `Nothing ${MEETING_BUCKET_LABELS[bucket].toLowerCase()}.`}
        </p>
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
