import { IngestAuthError, requireIngestToken } from "@/lib/ingestAuth";
import { mergeLeads } from "@/lib/leadDb";
import { LeadsCsvError, parseLeadsCsv } from "@/lib/parseLeadsCsv";
import {
  DEFAULT_LEAD_SOURCE,
  LEAD_SOURCES,
  parseLeadSource,
  type Lead,
  type LeadSource,
} from "@/lib/types";

/**
 * POST /api/leads/ingest — the scraper's push endpoint.
 *
 * The scrapers are separate projects in separate directories (and on separate
 * machines in production), so they cannot import `lib/` or reach Postgres. A
 * run finishes, then POSTs the CSVs from its output folder here.
 *
 * There are two of them now — one reading Yelp, one reading Google Maps — and
 * they share this endpoint rather than getting one each. They produce the same
 * shape of row about the same kind of business into the same table, and the one
 * thing that genuinely differs is *which directory it came from*, which is a
 * column (`X-Source`, below) rather than a second route with a duplicate copy
 * of the parse, merge and reporting in it.
 *
 * How this differs from the sibling `POST /api/leads/upload`, and why both
 * exist rather than one route with a flag:
 *
 *   upload  — a human picking a file in the Import view. **Replaces** the
 *             worklist, which is what that screen has always meant, and is
 *             safe because a person chose it. No auth; nginx Basic Auth is in
 *             front of the browser.
 *   ingest  — a scheduled machine. **Merges**: a business already in the table
 *             is left alone, so statuses, notes and booked callbacks survive a
 *             re-scrape. Bearer token, because this route is exempt from Basic
 *             Auth at the edge (see deploy/nginx/leadportal.conf).
 *
 * A single route with `?mode=replace` would put "delete every lead" one typo in
 * a cron line away, so the destructive semantics stay where a human triggers
 * them.
 *
 * Accepts a whole output folder in one request: repeat the `file` field per
 * CSV. Parsing is `parseLeadsCsv`, unchanged and shared with both other
 * callers, so column aliases and phone rules cannot drift between the scraper
 * path and the browser one.
 */

/** A scraper run is a folder, so the ceiling is per-request, not per-file. */
const MAX_BYTES = 32 * 1024 * 1024;

/** Nothing here is cacheable, and the token check must run on every request. */
export const dynamic = "force-dynamic";

interface IngestFile {
  filename: string;
  text: string;
}

interface FileReport {
  filename: string;
  parsedRows: number;
  usableRows: number;
  skippedRows: number;
  removedNoPhone: number;
  removedDuplicates: number;
  /** What the rows in this file actually resolved to, per source. */
  bySource: Record<LeadSource, number>;
  warnings: string[];
}

/** Zero against every source, so a report always has the full shape. */
function emptySourceCounts(): Record<LeadSource, number> {
  return Object.fromEntries(LEAD_SOURCES.map((key) => [key, 0])) as Record<
    LeadSource,
    number
  >;
}

class IngestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Which directory this push came from, as declared by the scraper.
 *
 * A *fallback*, not an override: `parseLeadsCsv` believes a row's own `source`
 * column first and its listing URL second, and only reaches for this when
 * neither says. That ordering is what makes a mixed or mislabelled folder
 * survive — see `resolveSource` in `lib/parseLeadsCsv.ts`.
 *
 * An unknown value is rejected rather than defaulted. A scraper sending
 * `X-Source: Google Business` has been misconfigured, and quietly filing its
 * whole run under Yelp is how that goes unnoticed for a week — the same reason
 * an empty push is a 400 below.
 */
function readSource(header: string | null): LeadSource | Response {
  if (header === null || header.trim() === "") return DEFAULT_LEAD_SOURCE;
  const source = parseLeadSource(header);
  if (source) return source;
  return Response.json(
    {
      error: "unknown_source",
      message: `X-Source "${header}" is not a known lead source. Expected one of: ${LEAD_SOURCES.join(", ")}.`,
    },
    { status: 400 },
  );
}

/**
 * One id stamped on every row of this push, so a whole scraper run can be
 * traced or filtered as a unit. The scraper may name its own run via
 * `X-Batch`; otherwise the timestamp is what distinguishes two runs.
 */
function batchId(header: string | null): string {
  const stem = (header ?? "scraper")
    .replace(/\W+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${stem || "scraper"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

const tooLarge = () =>
  new IngestError(
    413,
    "too_large",
    `That push is over the ${MAX_BYTES / 1024 / 1024}MB limit. Send the folder in smaller pushes.`,
  );

/**
 * Either `multipart/form-data` with one or more `file` fields (the folder), or
 * a raw `text/csv` body naming itself with `X-Filename` — the latter is what
 * makes a one-liner `curl --data-binary @out.csv` work from a shell script.
 */
async function readFiles(request: Request): Promise<IngestFile[]> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    // `file` and `files` both accepted: which one a scraper's HTTP library
    // reaches for is a coin flip, and guessing wrong yields a confusing 400.
    const parts = [...form.getAll("file"), ...form.getAll("files")];
    const files = parts.filter((part): part is File => part instanceof File);

    if (files.length === 0) {
      throw new IngestError(
        400,
        "missing_file",
        'Expected at least one "file" field holding a CSV.',
      );
    }

    let total = 0;
    const out: IngestFile[] = [];
    for (const file of files) {
      total += file.size;
      if (total > MAX_BYTES) throw tooLarge();
      out.push({ filename: file.name || "upload.csv", text: await file.text() });
    }
    return out;
  }

  const text = await request.text();
  if (text.length > MAX_BYTES) throw tooLarge();
  if (!text.trim()) {
    throw new IngestError(400, "empty_body", "The request body was empty.");
  }
  return [{ filename: request.headers.get("x-filename") ?? "upload.csv", text }];
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireIngestToken(request);
  } catch (error) {
    if (error instanceof IngestAuthError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }

  const source = readSource(request.headers.get("x-source"));
  if (source instanceof Response) return source;

  const sourceBatch = batchId(request.headers.get("x-batch"));

  let files: IngestFile[];
  try {
    files = await readFiles(request);
  } catch (error) {
    if (error instanceof IngestError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }

  // Every file is parsed before anything is written, so one malformed CSV in
  // the folder is reported as a warning against that file rather than leaving
  // the push half-applied.
  const reports: FileReport[] = [];
  const candidates: Lead[] = [];

  for (const file of files) {
    try {
      const parsed = parseLeadsCsv(file.text, sourceBatch, source);
      candidates.push(...parsed.leads);
      reports.push({
        filename: file.filename,
        parsedRows: parsed.parsedRows,
        usableRows: parsed.leads.length,
        skippedRows: parsed.skippedRows,
        removedNoPhone: parsed.removedNoPhone,
        removedDuplicates: parsed.removedDuplicates,
        bySource: parsed.bySource,
        warnings: parsed.warnings,
      });
    } catch (error) {
      if (!(error instanceof LeadsCsvError)) throw error;
      reports.push({
        filename: file.filename,
        parsedRows: 0,
        usableRows: 0,
        skippedRows: 0,
        removedNoPhone: 0,
        removedDuplicates: 0,
        bySource: emptySourceCounts(),
        warnings: [`Could not parse: ${error.message}`],
      });
    }
  }

  const rejected = reports.filter((report) => report.usableRows === 0);

  if (candidates.length === 0) {
    // A 400 rather than a quiet 200: this is a cron job, and "0 rows" that
    // looks like success is how a broken scraper goes unnoticed for a week.
    return Response.json(
      {
        error: "no_rows",
        message: "No usable rows in that push.",
        files: reports,
      },
      { status: 400 },
    );
  }

  try {
    const merged = await mergeLeads(candidates, sourceBatch);

    return Response.json(
      {
        sourceBatch,
        inserted: merged.inserted,
        skippedExisting: merged.skippedExisting,
        receivedFiles: files.length,
        usableRows: candidates.length,
        // The source this push *declared*, and what its rows actually resolved
        // to. A scraper can compare the two and alert when they disagree —
        // which is what a Yelp CSV accidentally left in the Maps output folder
        // looks like from the outside.
        declaredSource: source,
        bySource: candidates.reduce((counts, lead) => {
          counts[lead.source] += 1;
          return counts;
        }, emptySourceCounts()),
        // Surfaced at the top level so a scraper can alert on it without
        // walking the per-file reports.
        rejectedFiles: rejected.map((report) => report.filename),
        files: reports,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("POST /api/leads/ingest failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Parsed the push, but could not save it. Check that Postgres is reachable.",
      },
      { status: 503 },
    );
  }
}
