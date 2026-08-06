import { normalisePhone } from "./leadUtils";
import type { Lead } from "./types";

/**
 * The ingestion gate. Every lead entering the app passes through here, whether
 * it came from a CSV, the bundled sample data or (later) a database read.
 *
 * Two rules, applied in order:
 *   1. A lead with no dialable phone number is dropped — an agent cannot work
 *      it, so it is noise on the worklist rather than a row to flag.
 *   2. Duplicates are collapsed to their first occurrence, matched either on
 *      normalised phone or on an identical name + address.
 *
 * Because it is idempotent, it is safe to run at every entry point: cleaning
 * already-clean data removes nothing.
 */

/** Minimum digits for a number worth dialling — a local 7-digit number. */
const MIN_PHONE_DIGITS = 7;

export function hasValidPhone(lead: Lead): boolean {
  return normalisePhone(lead.phone).length >= MIN_PHONE_DIGITS;
}

/**
 * Word-level equivalences, so the same address written two ways produces one
 * key. Matching on a truncated string instead (the old approach) fails exactly
 * where it matters: "2 Oak Ave, SF" and "2 Oak Avenue, SF" diverge at
 * character 8, well inside any useful prefix.
 */
const ADDRESS_SYNONYMS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  av: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  square: "sq",
  terrace: "ter",
  highway: "hwy",
  parkway: "pkwy",
  suite: "ste",
  apartment: "apt",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};

/** Legal-entity noise that shouldn't distinguish two records of one business. */
const NAME_NOISE = new Set(["co", "inc", "llc", "ltd", "corp", "the"]);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function normaliseName(name: string): string {
  return words(name)
    .filter((word) => !NAME_NOISE.has(word))
    .join("");
}

function normaliseAddress(address: string): string {
  return words(address)
    .map((word) => ADDRESS_SYNONYMS[word] ?? word)
    .join(" ");
}

/** The only fields identity is derived from — a database row satisfies it. */
export type LeadIdentity = Pick<Lead, "name" | "address" | "phone">;

/**
 * Identity keys for one lead. A lead is a duplicate if it collides with an
 * earlier lead on *any* of its keys — the same phone, or the same business
 * name at the same address.
 *
 * Exported because `mergeLeads` in `lib/leadDb.ts` matches incoming scraper
 * rows against rows *already in the table* using exactly this rule. Two
 * definitions of "same business" — one at CSV ingest, one at merge — would
 * disagree on the first address abbreviation and let a duplicate through.
 */
export function identityKeys(lead: LeadIdentity): string[] {
  const keys: string[] = [];

  const phone = normalisePhone(lead.phone);
  if (phone.length >= MIN_PHONE_DIGITS) keys.push(`phone:${phone}`);

  const name = normaliseName(lead.name);
  if (name) keys.push(`na:${name}|${normaliseAddress(lead.address)}`);

  return keys;
}

export interface CleanLeadsResult {
  leads: Lead[];
  /** Dropped for having no dialable number. */
  removedNoPhone: number;
  /** Dropped as a repeat of an earlier lead. */
  removedDuplicates: number;
}

export function cleanLeads(incoming: Lead[]): CleanLeadsResult {
  const seen = new Set<string>();
  const leads: Lead[] = [];
  let removedNoPhone = 0;
  let removedDuplicates = 0;

  for (const lead of incoming) {
    if (!hasValidPhone(lead)) {
      removedNoPhone += 1;
      continue;
    }

    const keys = identityKeys(lead);
    if (keys.some((key) => seen.has(key))) {
      removedDuplicates += 1;
      continue;
    }

    for (const key of keys) seen.add(key);
    leads.push(lead);
  }

  return { leads, removedNoPhone, removedDuplicates };
}

/**
 * Human-readable summary of what a clean removed, for the import banner.
 * Returns null when nothing was filtered, so callers can stay quiet.
 */
export function describeCleaning(result: CleanLeadsResult): string | null {
  const parts: string[] = [];
  if (result.removedDuplicates > 0) {
    parts.push(
      `${result.removedDuplicates} duplicate${result.removedDuplicates === 1 ? "" : "s"}`,
    );
  }
  if (result.removedNoPhone > 0) {
    parts.push(
      `${result.removedNoPhone} missing number${result.removedNoPhone === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return null;

  const removed = result.removedDuplicates + result.removedNoPhone;
  return `${parts.join(" and ")} ${removed === 1 ? "was" : "were"} automatically filtered out.`;
}
