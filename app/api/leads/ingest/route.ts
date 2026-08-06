import { IngestAuthError, requireIngestToken } from "@/lib/ingestAuth";
import { mergeLeads } from "@/lib/leadDb";
import { LeadsCsvError, parseLeadsCsv } from "@/lib/parseLeadsCsv";
import type { Lead } from "@/lib/types";

/**
 * POST /api/leads/ingest — the scraper's push endpoint.
 *
 * The Yelp scraper is a separate project in a separate directory (and on a
 * separate machine in production), so it cannot import `lib/` or reach
 * Postgres. It finishes a run, then POSTs the CSVs from its output folder here.
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
  warnings: string[];
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
      const parsed = parseLeadsCsv(file.text, sourceBatch);
      candidates.push(...parsed.leads);
      reports.push({
        filename: file.filename,
        parsedRows: parsed.parsedRows,
        usableRows: parsed.leads.length,
        skippedRows: parsed.skippedRows,
        removedNoPhone: parsed.removedNoPhone,
        removedDuplicates: parsed.removedDuplicates,
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
