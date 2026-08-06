import { normalisePhone } from "./leadUtils";

/**
 * Phone numbers -> `wa.me` links.
 *
 * `wa.me` takes a bare international number: digits only, no `+`, no spaces,
 * no dashes, no leading `00`. Anything else lands on WhatsApp's error page,
 * so the formatting here is the whole feature — get it wrong and the agent
 * learns nothing about whether the lead is on WhatsApp.
 */

/**
 * Assumed when a number carries no country code of its own. The lead data is
 * North American (10-digit numbers, NANP area codes), so `1` is the only
 * assumption that makes a plain `(415) 555-0182` dialable.
 */
const DEFAULT_COUNTRY_CODE = "1";

/** Shortest plausible international number (country code + subscriber). */
const MIN_INTERNATIONAL_DIGITS = 8;

/** Longest an E.164 number can be. */
const MAX_INTERNATIONAL_DIGITS = 15;

/**
 * A stored phone number as WhatsApp wants it: country code first, digits only.
 *
 * Returns null when the number cannot be resolved to an international one —
 * a 7-digit local number has no recoverable country or area code, and guessing
 * would send the agent to a stranger. Callers render nothing in that case.
 */
export function whatsappNumber(phone: string | null): string | null {
  if (!phone) return null;

  const trimmed = phone.trim();
  const digits = normalisePhone(trimmed);
  if (!digits) return null;

  // `+` and the `00` exit prefix both mean "a country code follows".
  const explicitlyInternational = trimmed.startsWith("+") || digits.startsWith("00");
  const bare = digits.startsWith("00") ? digits.slice(2) : digits;

  const resolved =
    explicitlyInternational || bare.length > 10
      ? bare
      : bare.length === 10
        ? // A bare NANP number: area code present, country code implied.
          DEFAULT_COUNTRY_CODE + bare
        : // 7-9 digits with no country code — local, and not recoverable.
          null;

  if (!resolved) return null;
  if (
    resolved.length < MIN_INTERNATIONAL_DIGITS ||
    resolved.length > MAX_INTERNATIONAL_DIGITS
  ) {
    return null;
  }

  return resolved;
}

/** `https://wa.me/14155550182`, or null when the number isn't usable. */
export function whatsappLink(phone: string | null): string | null {
  const number = whatsappNumber(phone);
  return number ? `https://wa.me/${number}` : null;
}
