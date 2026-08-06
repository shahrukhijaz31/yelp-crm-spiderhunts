import { todayIso } from "./leadUtils";
import type { Lead } from "./types";

/**
 * The Meetings view's domain rules.
 *
 * Membership is **derived, never stored**: a lead is a meeting because of its
 * status or its callback date, not because something added it to a list. That
 * is what makes the sync automatic — flip a lead to "Interested" on the
 * worklist and it is on the agenda on the next render, with nothing to
 * reconcile and nothing to leave behind when the status changes back.
 */

export type MeetingBucket = "today" | "upcoming" | "past" | "unscheduled";

export const MEETING_BUCKETS: MeetingBucket[] = [
  "today",
  "upcoming",
  "past",
  "unscheduled",
];

export const MEETING_BUCKET_LABELS: Record<MeetingBucket, string> = {
  today: "Today",
  upcoming: "Upcoming",
  past: "Past",
  unscheduled: "Needs a date",
};

export const MEETING_BUCKET_HINTS: Record<MeetingBucket, string> = {
  today: "Booked for today — work down the list in time order.",
  upcoming: "Everything booked from tomorrow onwards.",
  past: "Dates that have been and gone, including completed meetings.",
  unscheduled: "Interested leads with no date yet. Book these first.",
};

export interface Meeting {
  lead: Lead;
  /** The booked date, or null for an interested lead with nothing booked. */
  date: string | null;
  /** 24-hour `HH:MM`, or null when only a date is set. */
  time: string | null;
  bucket: MeetingBucket;
  completed: boolean;
}

/**
 * A lead belongs on the agenda if it is interested, or if a date has been put
 * in the diary for it — whatever its status.
 */
export function isMeetingLead(lead: Lead): boolean {
  return lead.status === "interested" || lead.callbackDate !== null;
}

function bucketFor(date: string | null, today: string): MeetingBucket {
  if (date === null) return "unscheduled";
  if (date === today) return "today";
  return date > today ? "upcoming" : "past";
}

export function toMeeting(lead: Lead, today: string): Meeting {
  return {
    lead,
    date: lead.callbackDate,
    time: lead.meetingTime,
    bucket: bucketFor(lead.callbackDate, today),
    completed: lead.meetingCompletedAt !== null,
  };
}

/** Chronological within a day: an untimed meeting sorts after timed ones. */
function compareByWhen(a: Meeting, b: Meeting): number {
  const dateOrder = (a.date ?? "").localeCompare(b.date ?? "");
  if (dateOrder !== 0) return dateOrder;
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time) return -1;
  if (b.time) return 1;
  return a.lead.name.localeCompare(b.lead.name);
}

export function collectMeetings(leads: Lead[], today = todayIso()): Meeting[] {
  return leads
    .filter(isMeetingLead)
    .map((lead) => toMeeting(lead, today))
    .sort(compareByWhen);
}

export function inBucket(meetings: Meeting[], bucket: MeetingBucket): Meeting[] {
  const matching = meetings.filter((meeting) => meeting.bucket === bucket);
  // Past reads best newest-first: the last thing you did is the thing you are
  // most likely to be looking for.
  return bucket === "past" ? [...matching].reverse() : matching;
}

export function countByBucket(
  meetings: Meeting[],
): Record<MeetingBucket, number> {
  const counts = Object.fromEntries(
    MEETING_BUCKETS.map((bucket) => [bucket, 0]),
  ) as Record<MeetingBucket, number>;
  for (const meeting of meetings) counts[meeting.bucket] += 1;
  return counts;
}

export interface MeetingDay {
  /** null groups the leads that still need a date. */
  date: string | null;
  meetings: Meeting[];
}

/** Group an already-sorted list into day headings, preserving order. */
export function groupByDay(meetings: Meeting[]): MeetingDay[] {
  const days: MeetingDay[] = [];
  for (const meeting of meetings) {
    const last = days.at(-1);
    if (last && last.date === meeting.date) last.meetings.push(meeting);
    else days.push({ date: meeting.date, meetings: [meeting] });
  }
  return days;
}

/** `2026-08-06` -> `Thursday 6 August`, with today and tomorrow named. */
export function formatMeetingDay(iso: string, today: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1);

  const [ty, tm, td] = today.split("-").map(Number);
  const todayDate = new Date(ty, (tm ?? 1) - 1, td ?? 1);
  const diffDays = Math.round(
    (date.getTime() - todayDate.getTime()) / 86_400_000,
  );

  const long = date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  if (diffDays === 0) return `Today · ${long}`;
  if (diffDays === 1) return `Tomorrow · ${long}`;
  if (diffDays === -1) return `Yesterday · ${long}`;
  return long;
}

/** `14:30` -> `2:30 pm`. Returns null so callers can render their own dash. */
export function formatMeetingTime(time: string | null): string | null {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return time;
  const suffix = hours < 12 ? "am" : "pm";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
