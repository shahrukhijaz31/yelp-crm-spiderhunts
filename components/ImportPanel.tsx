"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { describeCleaning } from "@/lib/cleanLeads";
import {
  DEFAULT_LEAD_SOURCE,
  LEAD_SOURCES,
  LEAD_SOURCE_DOTS,
  LEAD_SOURCE_LABELS,
  type LeadSource,
} from "@/lib/types";

const EXPECTED_COLUMNS = [
  "name",
  "address",
  "categories",
  "phone_number",
  "website",
  "rating",
  "owner",
  "url",
  "source",
];

type Notice = { tone: "ok" | "error"; message: string; lines?: string[] };

/**
 * The Import view. The CSV button used to be crammed into the filter rail;
 * given its own screen it can explain the expected columns and report what
 * happened, which matters when someone drops in the wrong export.
 *
 * Parsing still lives in `lib/parseLeadsCsv`, but it now runs on the server:
 * the file is posted to `POST /api/leads/upload`, which parses it, writes the
 * rows to Postgres and reports what it did. The component's job is the file
 * handoff and the report, exactly as before.
 *
 * It holds no leads and never did anything with them: the one thing it showed
 * was how many there are, so it takes that as a number, and the route sends
 * back the new total rather than the table it used to re-read to compute one.
 * `router.refresh()` afterwards re-runs the server components, which is what
 * puts the import's effect into the nav bar's counters and the worklist.
 */

/** What `POST /api/leads/upload` returns on success. */
interface UploadResult {
  /** Rows actually written — new businesses only. */
  imported: number;
  /** Rows already in the worklist, left exactly as they were. */
  skippedExisting: number;
  /** Size of the worklist after the import. */
  total: number;
  removedNoPhone: number;
  removedDuplicates: number;
  /** What the rows actually resolved to — not simply what was picked below. */
  bySource: Record<LeadSource, number>;
  warnings: string[];
}
export default function ImportPanel({ initialTotal }: { initialTotal: number }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /*
   * Which directory this file came from, when the file itself does not say.
   *
   * A *fallback* and not a label: the server believes a row's own `source`
   * column first and its listing URL second (`resolveSource` in
   * `lib/parseLeadsCsv.ts`), so picking Google here cannot relabel a Yelp
   * export that was dropped in by mistake. That is why the report below counts
   * what actually landed rather than echoing this back.
   */
  const [source, setSource] = useState<LeadSource>(DEFAULT_LEAD_SOURCE);
  // Seeded by the server and moved on by the upload's own report, so the line
  // under the drop target is right immediately after an import rather than
  // waiting for the refresh below to come back.
  const [total, setTotal] = useState(initialTotal);

  async function handleFile(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("source", source);
      const response = await fetch("/api/leads/upload", { method: "POST", body });
      const payload = await response.json();

      if (!response.ok) {
        // The route explains itself — a bad header row, an empty file, or
        // Postgres being unreachable all come back with a usable message.
        setNotice({
          tone: "error",
          message: `Could not import ${file.name}: ${payload.message ?? response.statusText}`,
          lines: payload.warnings,
        });
        return;
      }

      const result = payload as UploadResult;
      setTotal(result.total);
      // The worklist, the nav counters and this page's own count are all
      // server-rendered from Postgres, and an import has just moved every one
      // of them. Re-running the server components is what refreshes all three
      // without this screen having to hold the data to do it itself.
      router.refresh();

      // "Added 120 new leads. 38 were already in the worklist and were left
      // unchanged. 15 duplicates and 8 missing numbers were filtered out.
      // 158 leads in total." Each sentence appears only when it has something
      // to say — the "already there" one is what tells an agent their existing
      // call history survived, so it is worth its own clause rather than a
      // number they have to work out by subtraction.
      const cleaned = describeCleaning({
        // `describeCleaning` reports only the two removal counts; the list is
        // part of the shared result shape and is not read for the sentence.
        leads: [],
        removedNoPhone: result.removedNoPhone,
        removedDuplicates: result.removedDuplicates,
      });
      // "…of which 312 from Google Maps and 4 from Yelp." Only drawn when the
      // file actually held both, because on a single-source import it would
      // restate the number in the sentence before it.
      const mixed = LEAD_SOURCES.filter((key) => (result.bySource?.[key] ?? 0) > 0);
      const breakdown =
        mixed.length > 1
          ? `From ${mixed
              .map((key) => `${result.bySource[key]} ${LEAD_SOURCE_LABELS[key]}`)
              .join(" and ")}.`
          : null;

      const sentences = [
        `Added ${result.imported} new lead${result.imported === 1 ? "" : "s"}.`,
        breakdown,
        result.skippedExisting > 0
          ? `${result.skippedExisting} ${result.skippedExisting === 1 ? "was" : "were"} already in the worklist and ${result.skippedExisting === 1 ? "was" : "were"} left unchanged.`
          : null,
        cleaned,
        `${result.total} lead${result.total === 1 ? "" : "s"} in total.`,
      ].filter(Boolean);

      setNotice({
        tone: "ok",
        message: sentences.join(" "),
        lines: result.warnings,
      });
    } catch {
      setNotice({
        tone: "error",
        message: `Could not upload ${file.name}. Check your connection and try again.`,
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="page-title">Import leads</h1>
        <p className="mt-3 page-intro">
          Load a CSV from either scraper. New businesses are added to the worklist
          and saved to the database; any already on it are left untouched, so
          statuses, notes and callbacks are never overwritten by an import. Rows
          without a dialable phone number, and repeats within the file, are
          removed automatically.
        </p>
      </header>

      {/*
        * --- Source ------------------------------------------------------
        *
        * Above the drop target, because it has to be answered before the file
        * is dropped — the upload starts the instant a file lands, and there is
        * no confirm step to change it in.
        *
        * Worded as a fallback rather than as a label, and it means it: the
        * server reads each row's own `source` column and listing URL first, so
        * a Maps export dropped here with "Yelp" selected still files itself as
        * Google. The sentence under the buttons says so, because a control that
        * looks decisive but is not is worse than no control.
        */}
      <section className="panel px-5 py-4">
        <h2 className="eyebrow">Source</h2>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {LEAD_SOURCES.map((option) => {
            const active = source === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setSource(option)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-ui transition-colors ${
                  active
                    ? "border-accent-line bg-accent-soft font-medium text-accent"
                    : "border-line bg-surface text-fg-2 hover:border-line-2 hover:text-fg"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEAD_SOURCE_DOTS[option]}`}
                />
                {LEAD_SOURCE_LABELS[option]}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-ui leading-relaxed text-fg-3">
          Used only for rows that do not say where they came from. A{" "}
          <span className="font-mono">source</span> column, or a listing URL on{" "}
          <span className="font-mono">yelp.com</span> or{" "}
          <span className="font-mono">google.com/maps</span>, wins over this —
          so dropping the wrong export here cannot mislabel it.
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        // The drop target is the largest object on the screen, so it carries
        // the drag state on its own: accent border, a warmed fill and an
        // accent halo the moment a file is over it. Anything subtler and an
        // agent cannot tell whether the browser has taken the drag.
        className={`flex flex-col items-center gap-4 rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors duration-150 ${
          dragging
            ? "border-accent bg-accent-soft"
            : "border-line-2 hover:border-fg-4 hover:bg-hover"
        }`}
      >
        {/* The icon tile, matching the empty states elsewhere in the app. */}
        <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-line bg-recessed">
          <UploadIcon />
        </span>
        <div>
          <p className="text-cell font-semibold text-fg">
            Drop a CSV here, or choose a file
          </p>
          <p className="mt-1.5 text-ui text-fg-3">
            Currently holding {total} lead{total === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="ui-btn ui-btn-primary"
        >
          {busy ? "Uploading…" : "Choose CSV file"}
        </button>
      </div>

      {notice && (
        <div
          className={`rounded-lg border px-4 py-3 ${
            notice.tone === "ok"
              ? "border-success-line bg-success-bg"
              : "border-danger-line bg-danger-bg"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <p
              className={`text-ui ${
                notice.tone === "ok" ? "text-success" : "text-danger"
              }`}
            >
              {notice.message}
            </p>
            {notice.tone === "ok" && (
              <button
                type="button"
                onClick={() => router.push("/")}
                className="shrink-0 rounded text-caption font-medium text-fg-2 underline underline-offset-4 transition-colors hover:text-fg"
              >
                Go to worklist
              </button>
            )}
          </div>
          {notice.lines && notice.lines.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
              {notice.lines.map((line) => (
                <li key={line} className="text-caption text-fg-3">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="panel px-5 py-4">
        <h2 className="eyebrow">Expected columns</h2>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {EXPECTED_COLUMNS.map((column) => (
            <li
              key={column}
              className="rounded border border-line bg-recessed px-2 py-1 font-mono text-caption text-fg-2"
            >
              {column}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-ui leading-relaxed text-fg-3">
          Common aliases (<span className="font-mono">phone</span>,{" "}
          <span className="font-mono">business_name</span>,{" "}
          <span className="font-mono">link</span>,{" "}
          <span className="font-mono">maps_url</span>,{" "}
          <span className="font-mono">main_category</span>) are accepted; unrecognised
          columns are ignored with a warning. Rows without a name are skipped,
          and a phone with fewer than seven digits counts as no phone at all, so
          that row is filtered out rather than imported.
        </p>
      </section>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7 text-fg-4">
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
