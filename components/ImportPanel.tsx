"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useLeads } from "./LeadsProvider";
import { describeCleaning } from "@/lib/cleanLeads";
import type { Lead } from "@/lib/types";

const EXPECTED_COLUMNS = [
  "name",
  "address",
  "categories",
  "phone_number",
  "website",
  "rating",
  "owner",
  "url",
];

type Notice = { tone: "ok" | "error"; message: string; lines?: string[] };

/**
 * The Import view. The CSV button used to be crammed into the filter rail;
 * given its own screen it can explain the expected columns and report what
 * happened, which matters when someone drops in the wrong export.
 *
 * Parsing still lives in `lib/parseLeadsCsv`, but it now runs on the server:
 * the file is posted to `POST /api/leads/upload`, which parses it, writes the
 * rows to Postgres and hands back the stored leads. The component's job is the
 * file handoff and the report, exactly as before.
 */

/** What `POST /api/leads/upload` returns on success. */
interface UploadResult {
  leads: Lead[];
  /** Rows actually written — new businesses only. */
  imported: number;
  /** Rows already in the worklist, left exactly as they were. */
  skippedExisting: number;
  /** Size of the worklist after the import. */
  total: number;
  removedNoPhone: number;
  removedDuplicates: number;
  warnings: string[];
}
export default function ImportPanel() {
  const { replaceLeads, leads } = useLeads();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
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
      replaceLeads(result.leads);

      // "Added 120 new leads. 38 were already in the worklist and were left
      // unchanged. 15 duplicates and 8 missing numbers were filtered out.
      // 158 leads in total." Each sentence appears only when it has something
      // to say — the "already there" one is what tells an agent their existing
      // call history survived, so it is worth its own clause rather than a
      // number they have to work out by subtraction.
      const cleaned = describeCleaning({
        leads: result.leads,
        removedNoPhone: result.removedNoPhone,
        removedDuplicates: result.removedDuplicates,
      });
      const sentences = [
        `Added ${result.imported} new lead${result.imported === 1 ? "" : "s"}.`,
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
          Load a CSV from the scraper. New businesses are added to the worklist
          and saved to the database; any already on it are left untouched, so
          statuses, notes and callbacks are never overwritten by an import. Rows
          without a dialable phone number, and repeats within the file, are
          removed automatically.
        </p>
      </header>

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
        className={`flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-[border-color,background-color,box-shadow] duration-200 ${
          dragging
            ? "border-accent bg-accent-soft/40 shadow-[0_0_36px_-10px_var(--c-accent)]"
            : "border-line-2 bg-surface/70 hover:border-fg-4"
        }`}
      >
        {/* The icon tile, matching the empty states elsewhere in the app. */}
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-recessed shadow-e1">
          <UploadIcon />
        </span>
        <div>
          <p className="text-cell font-semibold text-fg">
            Drop a CSV here, or choose a file
          </p>
          <p className="mt-1.5 text-ui text-fg-3">
            Currently holding {leads.length} lead{leads.length === 1 ? "" : "s"}
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
          className={`rounded-xl border px-4 py-3 ${
            notice.tone === "ok"
              ? "border-st-green-line bg-st-green-bg"
              : "border-accent-3 bg-accent-soft"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <p
              className={`text-ui ${
                notice.tone === "ok" ? "text-st-green" : "text-accent-2"
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
          <span className="font-mono">link</span>) are accepted; unrecognised
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
