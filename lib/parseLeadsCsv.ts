import Papa from "papaparse";

import { cleanLeads } from "./cleanLeads";
import type { Lead } from "./types";

/**
 * CSV -> Lead[] conversion, isolated from React and from the browser.
 *
 * `parseLeadsCsv` takes a plain string, so the exact same function can later be
 * called from `app/api/leads/upload/route.ts` with the body of a POSTed file —
 * no rework needed. `parseLeadsCsvFile` is the thin browser-only wrapper that
 * reads a `File` and hands the text off.
 *
 * Expected columns (the scraper's output):
 *   name, address, categories, phone_number, website, rating, owner, url
 */

/** Header aliases, so a slightly renamed export column still lands correctly. */
const COLUMN_ALIASES: Record<keyof CsvRow, string[]> = {
  name: ["name", "business_name", "business name", "title"],
  address: ["address", "full_address", "location"],
  categories: ["categories", "category", "tags"],
  phone_number: ["phone_number", "phone", "phone number", "telephone"],
  website: ["website", "site", "web"],
  rating: ["rating", "stars", "score"],
  owner: ["owner", "owner_name", "contact"],
  url: ["url", "yelp_url", "listing_url", "link"],
};

interface CsvRow {
  name: string;
  address: string;
  categories: string;
  phone_number: string;
  website: string;
  rating: string;
  owner: string;
  url: string;
}

export interface ParseLeadsResult {
  /** Cleaned and de-duplicated — ready to put straight into state. */
  leads: Lead[];
  /** Non-fatal problems: unknown headers, rows skipped for having no name, etc. */
  warnings: string[];
  /** Rows present in the file but dropped because they had no business name. */
  skippedRows: number;
  /** Rows parsed before cleaning, so callers can show what was filtered. */
  parsedRows: number;
  /** Dropped by `cleanLeads` for having no dialable number. */
  removedNoPhone: number;
  /** Dropped by `cleanLeads` as repeats of an earlier row. */
  removedDuplicates: number;
}

export class LeadsCsvError extends Error {}

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Build a map of normalised CSV header -> canonical field name. */
function resolveHeaders(headers: string[]): {
  map: Map<string, keyof CsvRow>;
  unknown: string[];
} {
  const map = new Map<string, keyof CsvRow>();
  const unknown: string[] = [];

  for (const header of headers) {
    const normalised = normaliseHeader(header);
    const field = (Object.keys(COLUMN_ALIASES) as (keyof CsvRow)[]).find((key) =>
      COLUMN_ALIASES[key].some((alias) => normaliseHeader(alias) === normalised),
    );
    if (field) {
      map.set(header, field);
    } else if (normalised) {
      unknown.push(header);
    }
  }

  return { map, unknown };
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Empty-ish CSV values the scraper can emit for a missing field. */
function nullable(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered === "n/a" || lowered === "na" || lowered === "null" || lowered === "-") {
    return null;
  }
  return text;
}

function parseCategories(value: unknown): string[] {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseRating(value: unknown): number | null {
  const text = nullable(value);
  if (text === null) return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Digits-only phone check — a "phone" of `()` or `---` is not dialable and is
 * treated as missing, which means `cleanLeads` will drop the row entirely.
 */
function parsePhone(value: unknown): string | null {
  const text = nullable(value);
  if (text === null) return null;
  return text.replace(/\D/g, "").length >= 7 ? text : null;
}

/**
 * Parse CSV text into leads. Runtime-agnostic: no DOM, no fs.
 *
 * @param csvText raw file contents
 * @param idPrefix prefix for generated ids, so two uploads can't collide
 */
export function parseLeadsCsv(
  csvText: string,
  idPrefix = "csv",
): ParseLeadsResult {
  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });

  const headers = result.meta.fields ?? [];
  if (headers.length === 0) {
    throw new LeadsCsvError("The file has no header row.");
  }

  const { map, unknown } = resolveHeaders(headers);
  if (!Array.from(map.values()).includes("name")) {
    throw new LeadsCsvError(
      `No "name" column found. Expected columns: ${Object.keys(COLUMN_ALIASES).join(", ")}.`,
    );
  }

  const warnings: string[] = [];
  if (unknown.length > 0) {
    warnings.push(`Ignored unrecognised column(s): ${unknown.join(", ")}.`);
  }
  for (const error of result.errors.slice(0, 3)) {
    warnings.push(`Row ${(error.row ?? 0) + 1}: ${error.message}`);
  }

  const parsed: Lead[] = [];
  let skippedRows = 0;

  result.data.forEach((rawRow, index) => {
    // Re-key the row onto canonical field names.
    const row = {} as Record<keyof CsvRow, string>;
    for (const [header, field] of map) {
      row[field] = rawRow[header] ?? "";
    }

    const name = cleanText(row.name);
    if (!name) {
      skippedRows += 1;
      return;
    }

    parsed.push({
      id: `${idPrefix}-${index + 1}`,
      name,
      address: cleanText(row.address),
      categories: parseCategories(row.categories),
      phone: parsePhone(row.phone_number),
      website: nullable(row.website),
      rating: parseRating(row.rating),
      owner: nullable(row.owner),
      url: nullable(row.url),
      // Agent-owned fields always start empty on import.
      status: "not_called",
      notes: "",
      callbackDate: null,
      meetingTime: null,
      meetingAttendees: null,
      meetingNotes: "",
      meetingCompletedAt: null,
    });
  });

  if (skippedRows > 0) {
    warnings.push(`Skipped ${skippedRows} row(s) with no business name.`);
  }

  // Clean at the door: unreachable and repeated rows never enter the app, so
  // the worklist has nothing to flag and the agent has nothing to skip past.
  const cleaned = cleanLeads(parsed);

  return {
    leads: cleaned.leads,
    warnings,
    skippedRows,
    parsedRows: parsed.length,
    removedNoPhone: cleaned.removedNoPhone,
    removedDuplicates: cleaned.removedDuplicates,
  };
}

/** Browser-only convenience wrapper around {@link parseLeadsCsv}. */
export async function parseLeadsCsvFile(file: File): Promise<ParseLeadsResult> {
  const text = await file.text();
  const idPrefix = file.name.replace(/\.csv$/i, "").replace(/\W+/g, "-").slice(0, 24) || "csv";
  return parseLeadsCsv(text, idPrefix);
}
