"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  AudioLines,
  CalendarCheck2,
  CalendarClock,
  PenLine,
  PhoneOutgoing,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { formatMeetingDay, formatMeetingTime } from "@/lib/meetings";
import type { RecordingSummary } from "@/lib/recordingRules";
import type { Lead } from "@/lib/types";

/**
 * What is actually known about this lead's history, as a timeline.
 *
 * **Nothing here is invented, and that is the design constraint.** This app has
 * no activity table: it does not record that a status went from No answer to
 * Interested, or that a note was edited at 2:28pm, because nothing has ever
 * written those rows. A timeline that showed them would be a fiction, and the
 * one place a fiction is most expensive is the panel an agent reads to remember
 * what happened last time.
 *
 * So the trail is assembled from the timestamps Postgres genuinely keeps (see
 * schema.prisma):
 *
 *   created_at            the lead arrived, and which import it came in on
 *   first_called_at       the moment it crossed from New to Called
 *   updated_at            the last time an agent saved anything against it
 *   meeting_completed_at  the day a meeting was marked done
 *   recordings.created_at who uploaded a call recording, and when
 *
 * Plus one forward-looking row for a booking that has not happened yet, kept
 * visually apart from the history because it is a plan rather than a record.
 *
 * The grouping is done in the browser on purpose: "Today" has to mean today
 * where the agent is sitting, and `formatMeetingDay` is the same function the
 * Meetings agenda names its days with.
 *
 * If a real activity log is added later, this component gains rows and loses
 * nothing — the shape it draws is already one event per line.
 */

interface ActivityEvent {
  key: string;
  /** `YYYY-MM-DD` in the reader's timezone — what the day heading groups on. */
  day: string;
  /** Sort key. Date-only events sit at the end of their day. */
  at: number;
  /** `2:34 PM`, or null for an event known only to the day. */
  clock: string | null;
  icon: LucideIcon;
  title: string;
  detail?: React.ReactNode;
}

/** A local `YYYY-MM-DD` for an instant — never the UTC one, which shifts days. */
function localDay(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function clockOf(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** An ISO instant as an event, or null when the timestamp is absent or junk. */
function instantEvent(
  iso: string | null,
  event: Omit<ActivityEvent, "day" | "at" | "clock">,
): ActivityEvent | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return { ...event, day: localDay(date), at: date.getTime(), clock: clockOf(date) };
}

export default function LeadActivity({
  lead,
  today,
  createdAt,
  updatedAt,
  firstCalledAt,
  sourceBatch,
  recording,
}: {
  lead: Lead;
  today: string;
  createdAt: string;
  updatedAt: string;
  firstCalledAt: string | null;
  sourceBatch: string | null;
  recording: RecordingSummary | null;
}) {
  const reduced = useReducedMotion();

  const events: ActivityEvent[] = [];

  const created = instantEvent(createdAt, {
    key: "created",
    icon: Sparkles,
    title: "Added to the workspace",
    detail: sourceBatch ? `Imported in ${sourceBatch}` : undefined,
  });
  if (created) events.push(created);

  const worked = instantEvent(firstCalledAt, {
    key: "first-called",
    icon: PhoneOutgoing,
    title: "First worked",
    detail: "Moved from the New queue to Called",
  });
  if (worked) events.push(worked);

  const uploaded = recording
    ? instantEvent(recording.uploadedAt, {
        key: `recording-${recording.id}`,
        icon: AudioLines,
        title: "Call recording uploaded",
        detail: `By ${recording.uploadedBy.name}`,
      })
    : null;
  if (uploaded) events.push(uploaded);

  // Only when it says something the two above do not. Prisma stamps
  // `updated_at` on the same write that stamps `first_called_at`, so on a lead
  // worked exactly once the two are the same instant and one line is honest
  // where two would imply a second visit that never happened.
  const saved = instantEvent(updatedAt, {
    key: "updated",
    icon: PenLine,
    title: "Last saved",
    detail: "Status, notes or meeting detail",
  });
  if (saved && !events.some((event) => Math.abs(event.at - saved.at) < 2000)) {
    events.push(saved);
  }

  // A `DATE` column: the day is all that was ever recorded, so no clock is
  // shown rather than one invented from midnight.
  if (lead.meetingCompletedAt) {
    events.push({
      key: "meeting-completed",
      day: lead.meetingCompletedAt,
      // End of that day, so it sorts after anything timed on the same date.
      at: new Date(`${lead.meetingCompletedAt}T23:59:59`).getTime(),
      clock: null,
      icon: CalendarCheck2,
      title: "Meeting marked complete",
    });
  }

  events.sort((a, b) => b.at - a.at);

  // Grouped in order, so a day heading is emitted once per run rather than
  // per event.
  const days: Array<{ day: string; events: ActivityEvent[] }> = [];
  for (const event of events) {
    const last = days.at(-1);
    if (last && last.day === event.day) last.events.push(event);
    else days.push({ day: event.day, events: [event] });
  }

  // The booking, if there is one and it has not been marked done. Above the
  // history and styled apart from it: this has not happened yet.
  const upcoming =
    lead.callbackDate && !lead.meetingCompletedAt && lead.callbackDate >= today
      ? {
          day: lead.callbackDate,
          time: formatMeetingTime(lead.meetingTime),
        }
      : null;

  return (
    <section aria-labelledby="ws-activity" className="flex flex-col">
      <h2 id="ws-activity" className="eyebrow">
        Activity
      </h2>

      {upcoming && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-accent-line bg-accent-soft px-3 py-2.5">
          <CalendarClock
            className="mt-0.5 h-4 w-4 shrink-0 text-accent"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-caption font-medium text-fg">
              {upcoming.time ? "Meeting booked" : "Call-back booked"}
            </p>
            <p className="mt-0.5 text-caption text-fg-2">
              {formatMeetingDay(upcoming.day, today)}
              {upcoming.time && (
                <span className="tnum font-mono"> · {upcoming.time}</span>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="mt-3.5 flex flex-col gap-4">
        {days.map((group, groupIndex) => (
          <div key={group.day}>
            {/* The day, as a rule with a label on it — the heading and the
                divider are one object, which is what keeps a long trail
                reading as a stack of days rather than a list with captions. */}
            <div className="flex items-center gap-2.5">
              <span className="shrink-0 text-meta font-medium uppercase tracking-[0.05em] text-fg-3">
                {formatMeetingDay(group.day, today)}
              </span>
              <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-line" />
            </div>

            <ol className="mt-2">
              {group.events.map((event, index) => {
                const Icon = event.icon;
                return (
                  <motion.li
                    key={event.key}
                    initial={reduced ? false : { opacity: 0, x: 6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{
                      duration: reduced ? 0 : 0.22,
                      delay: reduced ? 0 : Math.min(0.24, (groupIndex * 3 + index) * 0.04),
                      ease: [0.22, 0.61, 0.36, 1],
                    }}
                    className="timeline-row"
                  >
                    <span aria-hidden="true" className="timeline-node">
                      <Icon className="h-3 w-3" strokeWidth={2} />
                    </span>
                    <div className="min-w-0 pb-3.5">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-caption font-medium text-fg">
                        {event.title}
                        {event.clock && (
                          <span className="tnum font-mono text-meta font-normal text-fg-4">
                            {event.clock}
                          </span>
                        )}
                      </p>
                      {event.detail && (
                        <p className="mt-0.5 text-caption text-fg-3">{event.detail}</p>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>

      {/* Said once, quietly, at the foot: the trail is short because the
          record is short, not because the panel is broken. */}
      <p className="mt-1 text-meta leading-relaxed text-fg-4">
        Only events the workspace records are shown. Individual status changes
        and note edits are not kept as history.
      </p>
    </section>
  );
}
