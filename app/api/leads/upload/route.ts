import { replaceAllLeads } from "@/lib/leadDb";
import { LeadsCsvError, parseLeadsCsv } from "@/lib/parseLeadsCsv";

/**
 * POST /api/leads/upload — import a CSV into Postgres.
 *
 * The Import view used to parse in the browser and drop the rows into React
 * state; it now posts the file here and the rows are written to the database,
 * so a refresh (or a second machine) sees the same worklist.
 *
 * `parseLeadsCsv` is reused verbatim, which is what it was built for: it takes
 * a plain string and touches no DOM or File API, so the browser path and this
 * one cannot drift on column aliases, phone validation or de-duplication.
 *
 * Deliberately *not* here: the API-key check the stub sketched out. This build
 * has no authentication anywhere, and a secret on one route would imply a
 * protection the rest of the app does not have. It goes in when auth does.
 *
 * Semantics match what the Import view has always done: an upload **replaces**
 * the worklist rather than merging into it (see `replaceAllLeads`).
 */

/** Roughly 40k rows of scraper output — well past any real export. */
const MAX_BYTES = 8 * 1024 * 1024;

/** A CSV filename -> the `source_batch` stamped on every row of that import. */
function batchIdFromFilename(filename: string | null): string {
  const stem = (filename ?? "upload")
    .replace(/\.csv$/i, "")
    .replace(/\W+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  // The timestamp is what makes two uploads of the same file distinguishable,
  // which is the point of being able to trace a row back to its batch.
  return `${stem || "upload"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Accepts either `multipart/form-data` with a `file` field (what the Import
 * view sends) or a raw `text/csv` body (convenient from curl or a cron job).
 */
async function readCsv(
  request: Request,
): Promise<{ text: string; filename: string | null } | Response> {
  const tooLarge = () =>
    Response.json(
      { error: "too_large", message: `That file is over the ${MAX_BYTES / 1024 / 1024}MB limit.` },
      { status: 413 },
    );

  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json(
        { error: "missing_file", message: 'Expected a "file" field holding the CSV.' },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) return tooLarge();
    return { text: await file.text(), filename: file.name };
  }

  const text = await request.text();
  if (text.length > MAX_BYTES) return tooLarge();
  return { text, filename: request.headers.get("x-filename") };
}

export async function POST(request: Request): Promise<Response> {
  const read = await readCsv(request);
  if (read instanceof Response) return read;

  const sourceBatch = batchIdFromFilename(read.filename);

  let parsed;
  try {
    parsed = parseLeadsCsv(read.text, sourceBatch);
  } catch (error) {
    if (error instanceof LeadsCsvError) {
      return Response.json({ error: "invalid_csv", message: error.message }, { status: 400 });
    }
    throw error;
  }

  if (parsed.leads.length === 0) {
    // Nothing usable — leave the existing worklist alone rather than wiping it
    // for an empty or mis-shaped file.
    return Response.json(
      {
        error: "no_rows",
        message: "No usable rows in that file.",
        warnings: parsed.warnings,
        removedNoPhone: parsed.removedNoPhone,
        removedDuplicates: parsed.removedDuplicates,
      },
      { status: 400 },
    );
  }

  try {
    // The stored rows come back rather than the parsed ones, so the client gets
    // the database's cuids — the ids every later PATCH is addressed to.
    const leads = await replaceAllLeads(parsed.leads, sourceBatch);

    return Response.json(
      {
        leads,
        imported: leads.length,
        sourceBatch,
        parsedRows: parsed.parsedRows,
        skippedRows: parsed.skippedRows,
        removedNoPhone: parsed.removedNoPhone,
        removedDuplicates: parsed.removedDuplicates,
        warnings: parsed.warnings,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("POST /api/leads/upload failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message:
          "Parsed the file, but could not save it. Check that Postgres is running, then try again.",
      },
      { status: 503 },
    );
  }
}
