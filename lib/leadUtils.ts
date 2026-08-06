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

/**
 * A scraped website value as something safe to put in `href`, or null if it
 * cannot be one.
 *
 * The scraper emits whatever Yelp shows, which is usually a bare domain —
 * `acecarspa.com`. A browser reads that as a *relative* path, so the link
 * opened `https://leadportal.…/acecarspa.com` instead of the business's site.
 * Anything without an `http(s)://` scheme gets one here.
 *
 * The null return is not just tidiness. This string comes from a third-party
 * page and lands in an anchor, so `javascript:` (and `data:`) must not survive
 * the trip — a value crafted into a listing would otherwise run when an agent
 * clicked the link. Only http and https get a URL back; everything else is
 * rendered as plain text by the caller.
 *
 * Done at render rather than at ingest so the ~thousands of rows already in the
 * table are fixed too, without a migration or a re-scrape.
 */
export function websiteHref(website: string): string | null {
  const trimmed = website.trim();
  if (!trimmed) return null;

  // A leading `word:` is only a scheme if there is no dot in the word —
  // otherwise `example.com:8080` reads as one, and a host:port would be both
  // rejected as a foreign scheme and left without the `https://` it needs.
  const candidate = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1];
  const scheme = candidate && !candidate.includes(".") ? candidate : null;
  if (scheme && !/^https?$/i.test(scheme)) return null;

  // Leading slashes stripped so a protocol-relative `//example.com` does not
  // become `https:///example.com`.
  const absolute = scheme ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;

  try {
    const url = new URL(absolute);
    // Belt and braces: a scheme that slipped past the check above (say a
    // leading-dot oddity) still cannot leave here as anything but http(s).
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    // Not a URL at all — "n/a" survives `nullable()`, "call for details" does
    // not parse. Better as unlinked text than a link that goes nowhere.
    return null;
  }
}
