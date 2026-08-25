import Papa from "papaparse";

import { cleanLeads } from "./cleanLeads";
import { parseAddressLocation } from "./leadLocation";
import {
  DEFAULT_LEAD_SOURCE,
  LEAD_SOURCES,
  leadSourceFromUrl,
  parseLeadSource,
  type Lead,
  type LeadSource,
} from "./types";

/**
 * CSV -> Lead[] conversion, isolated from React and from the browser.
 *
 * `parseLeadsCsv` takes a plain string, so the exact same function can later be
 * called from `app/api/leads/upload/route.ts` with the body of a POSTed file —
 * no rework needed. `parseLeadsCsvFile` is the thin browser-only wrapper that
 * reads a `File` and hands the text off.
 *
 * Expected columns (either scraper's output):
 *   name, address, categories, phone_number, website, rating, owner, url
 *
 * Plus an optional `source` column. Two scrapers now feed this parser — Yelp
 * and Google Maps — and neither is asked to agree with the other on column
 * names: the aliases below cover both vocabularies, so a Maps export naming its
 * link `maps_url` and its category `main_category` lands in the same shape a
 * Yelp export does.
 */

/** Header aliases, so a slightly renamed export column still lands correctly. */
const COLUMN_ALIASES: Record<keyof CsvRow, string[]> = {
  name: ["name", "business_name", "business name", "title"],
  address: ["address", "full_address", "location", "formatted_address"],
  categories: ["categories", "category", "tags", "main_category", "types"],
  phone_number: [
    "phone_number",
    "phone",
    "phone number",
    "telephone",
    "international_phone_number",
  ],
  website: ["website", "site", "web", "domain"],
  rating: ["rating", "stars", "score", "average_rating"],
  owner: ["owner", "owner_name", "contact", "owner_title"],
  url: [
    "url",
    "yelp_url",
    "listing_url",
    "link",
    // What a Google Maps export calls the same column.
    "maps_url",
    "google_url",
    "google_maps_url",
    "place_link",
    "place_url",
  ],
  /**
   * Which directory the row came from, when the file says so.
   *
   * Optional, and usually absent: the Yelp scraper predates the column
   * entirely, and a Maps export names the source in its filename rather than in
   * a column. {@link resolveSource} is what fills the gap — this is only the
   * first and most explicit of the three ways a row gets a source.
   */
  source: ["source", "lead_source", "platform", "directory"],
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
  source: string;
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
  /**
   * How many of the kept rows landed on each source.
   *
   * Reported rather than assumed, because a source is *resolved* per row (see
   * {@link resolveSource}) and not simply taken from the caller. A push the
   * Google scraper labelled `google` that comes back "412 Yelp" is a mislabelled
   * run, and the import banner and the ingest response both say so instead of
   * silently filing a whole scrape under the wrong directory.
   */
  bySource: Record<LeadSource, number>;
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
 * One row's source, from the three things that can say what it is, in the order
 * they deserve to be believed.
 *
 *   1. The row's own `source` column, when the file has one and it names a
 *      source we know. The file is being explicit; nothing outranks that.
 *   2. The listing URL's host. A Maps export always carries
 *      `https://www.google.com/maps/place/…`, so a run that forgot the column
 *      still files itself correctly — which matters because the alternative is
 *      not "unknown", it is "silently Yelp".
 *   3. The caller's default: the `?source=` an admin picked in the Import view,
 *      or the `X-Source` the scraper sent. Absent that, `DEFAULT_LEAD_SOURCE`.
 *
 * Note the order between 2 and 3: the row's own URL beats the header. A scraper
 * pushing a folder can hand over one CSV from the other run by accident, and a
 * per-request label would relabel every row in it; a per-row URL cannot.
 */
function resolveSource(
  sourceCell: unknown,
  url: string | null,
  fallback: LeadSource,
): LeadSource {
  return parseLeadSource(sourceCell) ?? leadSourceFromUrl(url) ?? fallback;
}

/**
 * Parse CSV text into leads. Runtime-agnostic: no DOM, no fs.
 *
 * @param csvText raw file contents
 * @param idPrefix prefix for generated ids, so two uploads can't collide
 * @param defaultSource which directory rows came from when neither a `source`
 *   column nor the listing URL says. See {@link resolveSource}.
 */
export function parseLeadsCsv(
  csvText: string,
  idPrefix = "csv",
  defaultSource: LeadSource = DEFAULT_LEAD_SOURCE,
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

    const url = nullable(row.url);

    parsed.push({
      id: `${idPrefix}-${index + 1}`,
      name,
      address: cleanText(row.address),
      categories: parseCategories(row.categories),
      phone: parsePhone(row.phone_number),
      website: nullable(row.website),
      rating: parseRating(row.rating),
      owner: nullable(row.owner),
      url,
      source: resolveSource(row.source, url, defaultSource),
      /*
       * Location, read out of the address the row just supplied.
       *
       * No directory sends a country or a city column, so there is nothing to
       * alias in `COLUMN_ALIASES` and nothing to fall back to — the address is
       * the only place the information exists. Derived here so that a parsed
       * lead is complete before it reaches `cleanLeads`, the preview table or
       * the database, and `toCreateData` re-derives it at the door for the same
       * reason: neither end has to trust the other.
       */
      ...parseAddressLocation(cleanText(row.address)),
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

  // Counted after the clean, so the figure describes the rows that were
  // actually kept rather than the ones the file contained.
  const bySource = Object.fromEntries(
    LEAD_SOURCES.map((source) => [source, 0]),
  ) as Record<LeadSource, number>;
  for (const lead of cleaned.leads) bySource[lead.source] += 1;

  return {
    leads: cleaned.leads,
    warnings,
    skippedRows,
    parsedRows: parsed.length,
    removedNoPhone: cleaned.removedNoPhone,
    removedDuplicates: cleaned.removedDuplicates,
    bySource,
  };
}

/** Browser-only convenience wrapper around {@link parseLeadsCsv}. */
export async function parseLeadsCsvFile(
  file: File,
  defaultSource: LeadSource = DEFAULT_LEAD_SOURCE,
): Promise<ParseLeadsResult> {
  const text = await file.text();
  const idPrefix = file.name.replace(/\.csv$/i, "").replace(/\W+/g, "-").slice(0, 24) || "csv";
  return parseLeadsCsv(text, idPrefix, defaultSource);
}
