import { CALL_STATUSES, isCalled, type CallStatus, type Lead } from "./types";

/** Today's date as `YYYY-MM-DD` in the agent's local timezone. */
export function todayIso(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/** Digits only, so `(415) 555-0100` and `415-555-0100` compare equal. */
export function normalisePhone(phone: string | null): string {
  return phone ? phone.replace(/\D/g, "") : "";
}

/*
 * Duplicate *detection* used to live here so the table could flag repeats.
 * Duplicates are now collapsed at ingest instead — see `lib/cleanLeads.ts`,
 * which owns both the identity rules and the phone-validity rule.
 */

export type CallbackState = "none" | "future" | "today" | "overdue";

export function callbackState(lead: Lead, today = todayIso()): CallbackState {
  if (!lead.callbackDate) return "none";
  if (lead.callbackDate < today) return "overdue";
  if (lead.callbackDate === today) return "today";
  return "future";
}

export interface LeadStats {
  total: number;
  called: number;
  notCalled: number;
  byStatus: Record<CallStatus, number>;
  callbackDueToday: number;
  callbackOverdue: number;
  /*
   * Phone and duplicate counts are gone on purpose: `cleanLeads` guarantees
   * every lead in state has a dialable, unique number, so those figures would
   * be permanently zero. Website is the one key field still worth counting.
   */
  missingWebsite: number;
}

export function computeStats(leads: Lead[], today = todayIso()): LeadStats {
  const byStatus = Object.fromEntries(
    CALL_STATUSES.map((status) => [status, 0]),
  ) as Record<CallStatus, number>;

  let called = 0;
  let callbackDueToday = 0;
  let callbackOverdue = 0;
  let missingWebsite = 0;

  for (const lead of leads) {
    byStatus[lead.status] += 1;
    if (isCalled(lead.status)) called += 1;
    if (!lead.website) missingWebsite += 1;

    const state = callbackState(lead, today);
    if (state === "today") callbackDueToday += 1;
    if (state === "overdue") callbackOverdue += 1;
  }

  return {
    total: leads.length,
    called,
    notCalled: leads.length - called,
    byStatus,
    callbackDueToday,
    callbackOverdue,
    missingWebsite,
  };
}

/** `2026-08-04` -> `Aug 4` (or `Aug 4, 2025` when not the current year). */
export function formatCallbackDate(iso: string, today = todayIso()): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Strip protocol/`www.`/trailing slash so the website column stays scannable. */
export function displayWebsite(website: string): string {
  return website
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}
