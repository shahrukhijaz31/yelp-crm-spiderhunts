import { prisma } from "./prisma";
import { isCalled, type CallStatus, type Lead, type LeadEditableFields } from "./types";

/**
 * Who worked which lead, recorded from the save that was already happening.
 *
 * **Why this exists at all.** The `leads` table records what happened to a lead
 * but not who made it happen, and it is overwritten in place — so it can say
 * "this lead is Interested and was first called on Tuesday" and can never say
 * "Umar called it". Every per-agent figure in the portal is counted from the
 * rows this module writes, and there is no other source for them.
 *
 * **What counts, and what deliberately does not.** An activity row is written
 * only from `PATCH /api/leads/:id` — the one endpoint that persists an agent's
 * work — and only for the four *acts* below. Opening a lead, expanding a row,
 * clicking the phone number, running a search or paging through the list reach
 * no write at all and therefore cannot manufacture a statistic. That is the
 * same rule `updateLeadFields` already applies to the New/Called split, and it
 * is applied here for the same reason: a number an agent can inflate by
 * scrolling is not a number worth showing anyone.
 *
 * Writing happens on the server, from the session user. The browser never says
 * whose activity this is, so it cannot say it was somebody else's.
 */

export type LeadActivityKind =
  | "call_logged"
  | "callback_scheduled"
  | "meeting_booked"
  | "meeting_completed";

export interface LeadActivityDraft {
  kind: LeadActivityKind;
  /** The outcome as saved, for `call_logged`. Null on the other kinds. */
  status: CallStatus | null;
}

/**
 * Turn one save into the acts it represents.
 *
 * Pure, and separate from the write, so the rules are readable in one place and
 * testable without a database.
 *
 * A single save can be more than one act, and usually is: the Book meeting
 * dialog sends a date, a time and `status: "interested"` together, which is
 * genuinely a call logged *and* a meeting booked. Both are recorded, because
 * both are things the agent did and each is counted by a different figure.
 *
 * The rules, and what each is guarding against:
 *
 *   **call_logged** — the save carries a `status`, and it is a called status.
 *   Identical to the condition that stamps `first_called_at` (see
 *   `updateLeadFields`), so "worked" means exactly one thing across the app. A
 *   notes-only or callback-only save is bookkeeping and is not a call.
 *   Correcting a lead *back* to `not_called` is somebody undoing a mis-click
 *   and must not count as work.
 *
 *   **meeting_booked** — a time was set. In this app a meeting is a callback
 *   date with a time on it (`lib/meetings.ts` — there is no meetings table),
 *   and the time is what the Book meeting dialog adds, so the time is the
 *   signal. Requires a date to end up on the lead: a time with no date is not
 *   in anybody's diary.
 *
 *   **callback_scheduled** — a date was set or changed, and no time came with
 *   it. The `else` of the rule above rather than a separate condition, so one
 *   save is never counted as both a callback and a meeting.
 *
 *   **meeting_completed** — the meeting was marked done. Only on the transition
 *   to a date, so re-saving a completed meeting does not book a second one.
 *
 * Every rule compares against `before` where a repeat would otherwise be
 * counted twice, and skips a field the save did not carry at all. A partial
 * PATCH cannot invent an act it did not perform.
 */
export function describeLeadActivity(
  before: Pick<Lead, "callbackDate" | "meetingTime" | "meetingCompletedAt">,
  changes: Partial<LeadEditableFields>,
): LeadActivityDraft[] {
  const drafts: LeadActivityDraft[] = [];

  if ("status" in changes && changes.status !== undefined && isCalled(changes.status)) {
    drafts.push({ kind: "call_logged", status: changes.status });
  }

  // What the lead will look like after this save, for the fields the diary
  // rules read. `in` rather than `??`, because `null` is a meaningful value
  // here — it is how a callback is cleared — and would be swallowed by `??`.
  const nextDate = "callbackDate" in changes ? changes.callbackDate ?? null : before.callbackDate;
  const nextTime = "meetingTime" in changes ? changes.meetingTime ?? null : before.meetingTime;

  const timeAdded = "meetingTime" in changes && nextTime !== null && nextTime !== before.meetingTime;
  const dateAdded = "callbackDate" in changes && nextDate !== null && nextDate !== before.callbackDate;

  if (nextDate !== null && timeAdded) {
    drafts.push({ kind: "meeting_booked", status: null });
  } else if (dateAdded) {
    drafts.push({ kind: "callback_scheduled", status: null });
  }

  if (
    "meetingCompletedAt" in changes &&
    changes.meetingCompletedAt != null &&
    before.meetingCompletedAt === null
  ) {
    drafts.push({ kind: "meeting_completed", status: null });
  }

  return drafts;
}

/**
 * Write the acts a save represents.
 *
 * Fire-and-forget from the caller's point of view: reporting must never be the
 * reason an agent's call outcome fails to save. A lost row costs one number one
 * point; a failed save costs the agent the call they just made.
 *
 * `createMany` so a Book-meeting save is one statement rather than three.
 */
export async function recordLeadActivity(
  leadId: string,
  userId: string,
  drafts: LeadActivityDraft[],
): Promise<void> {
  if (drafts.length === 0) return;

  try {
    await prisma.leadActivity.createMany({
      data: drafts.map((draft) => ({
        leadId,
        userId,
        kind: draft.kind,
        status: draft.status,
      })),
    });
  } catch (error) {
    console.error(`Recording activity for lead ${leadId} failed:`, error);
  }
}
