import { apiAdmin } from "@/lib/authz";
import { listLeads, mergeLeads } from "@/lib/leadDb";
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
 * ADMIN only. An import rewrites the shared worklist for everyone in the
 * building, so it is not a thing an agent does — and hiding the Upload CSV tab
 * from them would be worthless on its own, since posting a multipart body to a
 * known URL takes one line of curl. The check below is what actually stops it.
 *
 * The scraper does not come through here. It posts to `/api/leads/ingest`,
 * which authenticates with its own bearer token (`lib/ingestAuth.ts`) because
 * it is a machine on another box with no session to carry.
 *
 * An upload **adds to** the worklist. It used to replace it — `deleteMany` then
 * insert — which was the right behaviour when the worklist lived in React state
 * and a reload lost it anyway. Against a real database it meant importing a
 * second CSV silently destroyed every status, note and callback date the agents
 * had recorded, with nothing but a line in the import banner to say so.
 *
 * So this now takes the same path the scraper does (`mergeLeads`): a business
 * already in the table is left completely untouched, and only genuinely new
 * ones are inserted. "Already in the table" uses `identityKeys` — normalised
 * phone, or name + address — the same rule `cleanLeads` applies within a file,
 * so it means the same thing at both ends.
 *
 * There is deliberately no "replace everything" option in the UI. Wiping the
 * table is a database operation with real consequences, not a checkbox next to
 * a file picker; see deploy/README.md for how to do it on purpose.
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
  // Before the body is read, so an agent's 8MB upload is refused rather than
  // parsed and then thrown away.
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

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
    // Nothing usable. Harmless now that an import only adds, but still worth
    // reporting as an error: a file that yields no rows is a mis-shaped export,
    // and silently answering "imported 0" would hide that.
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
    const merged = await mergeLeads(parsed.leads, sourceBatch);

    // The whole table is re-read rather than returned from the merge, so the
    // client gets the database's cuids for the new rows *and* keeps the
    // existing rows with the statuses, notes and callbacks already on them.
    // Those ids are what every later PATCH is addressed to.
    const leads = await listLeads();

    return Response.json(
      {
        leads,
        imported: merged.inserted,
        skippedExisting: merged.skippedExisting,
        total: leads.length,
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
