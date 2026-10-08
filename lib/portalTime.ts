/**
 * The portal's clock: Pakistan time, 12-hour.
 *
 * Every instant the portal shows — a status change, a shift start, a
 * screenshot, a lead's "Date added" — is printed in Asia/Karachi, whatever the
 * viewing computer or the server is set to. The team works in Pakistan, the
 * working day already starts at 11:00 Pakistan time (`performanceRules`), and a
 * laptop left on a US timezone was making 6:50 PM read as 6:50 AM. One zone for
 * everybody means two people looking at the same event see the same time.
 *
 * Calendar dates that are already `YYYY-MM-DD` strings (a callback day, a
 * report period) are not instants and are not converted — they mean the same
 * day everywhere.
 *
 * Pure, and safe on the server and in the browser alike: `Intl` with an
 * explicit `timeZone` gives the same answer in both, so nothing here can cause
 * a hydration mismatch.
 */

export const PORTAL_TIME_ZONE = "Asia/Karachi";

/** Pakistan is UTC+5 all year — no daylight saving — so this is fixed. */
const PORTAL_OFFSET = "+05:00";

type Instant = Date | string | number;

function toDate(value: Instant): Date {
  return value instanceof Date ? value : new Date(value);
}

/** `2:05 PM`, or `2:05:09 PM` with seconds. */
export function formatClock(value: Instant, withSeconds = false): string {
  return toDate(value).toLocaleTimeString("en-US", {
    timeZone: PORTAL_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: true,
  });
}

/** `Oct 8`, or with any other date fields asked for — always in Pakistan time. */
export function formatDate(
  value: Instant,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  return toDate(value).toLocaleDateString("en-US", { timeZone: PORTAL_TIME_ZONE, ...options });
}

/** `Oct 8, 2026, 2:05 PM`. */
export function formatDateTime(value: Instant): string {
  return toDate(value).toLocaleString("en-US", {
    timeZone: PORTAL_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  });
}

/** The Pakistan calendar day an instant falls on, as `YYYY-MM-DD`. */
export function portalDay(value: Instant): string {
  // en-CA prints dates as YYYY-MM-DD.
  return toDate(value).toLocaleDateString("en-CA", {
    timeZone: PORTAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** An instant as the Pakistan wall time a `datetime-local` input shows: `YYYY-MM-DDTHH:MM`. */
export function toPortalInput(value: Instant): string {
  const shifted = new Date(toDate(value).getTime() + 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

/** The inverse: a `datetime-local` value read as Pakistan time. Null if malformed. */
export function fromPortalInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00${PORTAL_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}
