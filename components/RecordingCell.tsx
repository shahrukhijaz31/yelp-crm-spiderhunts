"use client";

import { useRef, useState } from "react";

import RecordingPlayer, { formatClock } from "./RecordingPlayer";
import {
  ACCEPTED_EXTENSIONS,
  MAX_RECORDING_BYTES,
  type RecordingSummary,
} from "@/lib/recordingRules";

/**
 * The call-recording row inside a meeting card.
 *
 * One line when there is nothing to show and one line when there is — this is
 * a field on an existing card, not a feature with a screen of its own. Empty:
 * a label and a secondary button. Filled: the same label, a chip, the player,
 * and who uploaded it and when.
 *
 * Upload goes through `XMLHttpRequest` rather than `fetch`, for the one thing
 * fetch still cannot do in a browser: report request progress. A 25MB file on
 * an office connection is several seconds of nothing, and a spinner that
 * cannot say how far along it is turns "slow" into "broken" — so the bar is
 * driven by `upload.onprogress` and is real, not an animation.
 *
 * The limits and the format list come from `lib/recordingRules.ts` — the same
 * module the upload route validates against — so the "up to 25MB" under the
 * button and the 413 from the server can never disagree.
 */

type Notice = { tone: "ok" | "error"; message: string } | null;

export default function RecordingCell({
  leadId,
  leadName,
  recording,
  onSaved,
  onDeleted,
}: {
  leadId: string;
  leadName: string;
  recording: RecordingSummary | null;
  onSaved: (recording: RecordingSummary) => void;
  onDeleted: (leadId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  function closePanel() {
    setOpen(false);
    setFile(null);
    setAcknowledged(false);
    setProgress(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function chooseFile(next: File | null) {
    setNotice(null);
    if (next && next.size > MAX_RECORDING_BYTES) {
      // Refused here as well as on the server, so the agent is told before
      // spending a minute uploading something that will be rejected on
      // arrival. The server check is the one that counts.
      setFile(null);
      setNotice({
        tone: "error",
        message: `${next.name} is ${formatSize(next.size)} — the limit is ${formatSize(MAX_RECORDING_BYTES)}.`,
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(next);
  }

  async function upload() {
    if (!file || !acknowledged) return;

    setBusy(true);
    setNotice(null);
    setProgress(0);

    const body = new FormData();
    body.append("file", file);
    // Read from the file itself so the card can show a length straight away.
    // The server treats it as a display value and clamps it — it is the one
    // field in the request the client is the source of.
    const duration = await readDuration(file);
    if (duration !== null) body.append("durationSeconds", String(Math.round(duration)));

    try {
      const saved = await postWithProgress(
        `/api/meetings/${encodeURIComponent(leadId)}/recording`,
        body,
        setProgress,
      );
      onSaved(saved);
      closePanel();
      setNotice({ tone: "ok", message: "Recording uploaded." });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Upload failed. Try again.",
      });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!recording) return;
    if (!window.confirm(`Delete the call recording for ${leadName}? This cannot be undone.`)) {
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(leadId)}/recording`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message ?? "Could not delete that recording.");
      }
      onDeleted(leadId);
      setNotice({ tone: "ok", message: "Recording deleted." });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Could not delete that recording.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 border-t border-line pt-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="eyebrow shrink-0">Call recording</span>

        {recording ? (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-[5px] bg-st-sky-bg px-2 py-0.5 text-caption font-medium text-st-sky ring-1 ring-inset ring-st-sky-line">
              <HeadphonesIcon />
              Available
            </span>

            <RecordingPlayer
              // Keyed by the recording, so replacing one mounts a fresh
              // transport instead of leaving the scrubber where the previous
              // file's playhead was.
              key={recording.id}
              src={`/api/meetings/${encodeURIComponent(leadId)}/recording/stream`}
              fallbackDuration={recording.durationSeconds}
              label={leadName}
            />

            {recording.canManage && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setOpen(true);
                  }}
                  disabled={busy}
                  className="ui-btn h-8 px-2.5 text-fg-3 underline decoration-line-2 underline-offset-4 hover:text-fg"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={busy}
                  aria-busy={busy}
                  className="ui-btn h-8 px-2.5 text-fg-3 underline decoration-line-2 underline-offset-4 hover:text-accent"
                >
                  Delete
                </button>
              </div>
            )}
          </>
        ) : (
          !open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="ui-btn ui-btn-secondary h-8 px-2.5"
            >
              <PlusIcon />
              Upload call recording
            </button>
          )
        )}
      </div>

      {recording && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-fg-3">
          <span className="truncate">{recording.fileName}</span>
          <span aria-hidden="true">·</span>
          <span className="tnum font-mono">{formatSize(recording.fileSize)}</span>
          {recording.durationSeconds !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tnum font-mono">{formatClock(recording.durationSeconds)}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>
            Uploaded by <span className="text-fg-2">{recording.uploadedBy.name}</span>{" "}
            {formatUploadedAt(recording.uploadedAt)}
          </span>
        </p>
      )}

      {open && (
        <div className="mt-2.5 rounded-lg border border-line-2 bg-recessed p-3">
          {/* The compliance reminder sits on the action itself rather than in a
              tooltip or a page footer: it is the sentence the agent should read
              at the moment they pick a file, and it is deliberately a reminder
              of their own obligation, not advice about what the law is. */}
          <p className="text-caption text-fg-2">
            Only upload recordings you are authorized to record and share.
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept={[
                ...ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`),
                "audio/*",
              ].join(",")}
              disabled={busy}
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              className="max-w-full text-caption text-fg-2 file:mr-2.5 file:cursor-pointer file:rounded-lg file:border file:border-line-2 file:bg-surface file:px-2.5 file:py-1.5 file:text-caption file:font-medium file:text-fg-2 hover:file:border-fg-4 hover:file:bg-hover hover:file:text-fg"
            />
          </div>

          <label className="mt-2.5 flex items-start gap-2 text-caption text-fg-2">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--c-accent)]"
            />
            <span>
              I am authorized to record this call and to share it with the team.
            </span>
          </label>

          {progress !== null && (
            <div className="mt-2.5">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                aria-label="Upload progress"
                className="h-1.5 w-full overflow-hidden rounded-full bg-line-2"
              >
                <div
                  className="h-full bg-accent transition-[width] duration-150"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="tnum mt-1 font-mono text-meta text-fg-3">
                {progress < 1
                  ? `Uploading… ${Math.round(progress * 100)}%`
                  : "Saving on the server…"}
              </p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void upload()}
              disabled={!file || !acknowledged || busy}
              aria-busy={busy}
              className="ui-btn ui-btn-primary h-8 px-3"
            >
              {busy ? "Uploading…" : recording ? "Replace recording" : "Upload recording"}
            </button>
            <button
              type="button"
              onClick={closePanel}
              disabled={busy}
              className="ui-btn h-8 px-2.5 text-fg-3 hover:bg-hover hover:text-fg"
            >
              Cancel
            </button>
            <span className="text-meta text-fg-3">
              {ACCEPTED_EXTENSIONS.join(", ")} · up to {formatSize(MAX_RECORDING_BYTES)}
            </span>
          </div>
        </div>
      )}

      {notice && (
        <p
          className={`mt-2 text-caption ${notice.tone === "error" ? "text-warn" : "text-st-green"}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
    </div>
  );
}

/**
 * POST a FormData and report upload progress.
 *
 * `fetch` has no equivalent — request-body progress needs either XHR or a
 * duplex stream the browsers do not agree on — and a progress bar is the whole
 * difference between a slow upload and an app that looks stuck.
 */
function postWithProgress(
  url: string,
  body: FormData,
  onProgress: (fraction: number) => void,
): Promise<RecordingSummary> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.responseType = "json";

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });

    request.addEventListener("load", () => {
      const payload = request.response as { recording?: RecordingSummary; message?: string } | null;
      if (request.status >= 200 && request.status < 300 && payload?.recording) {
        resolve(payload.recording);
      } else {
        // The routes always explain themselves; the status is the fallback for
        // a response that never reached them (a proxy 413, say).
        reject(new Error(payload?.message ?? `Upload failed (${request.status}).`));
      }
    });

    request.addEventListener("error", () =>
      reject(new Error("Upload failed. Check your connection and try again.")),
    );
    request.addEventListener("abort", () => reject(new Error("Upload cancelled.")));

    request.send(body);
  });
}

/**
 * Ask the browser how long the audio is, without uploading it first.
 *
 * Best effort: a container the browser cannot decode simply yields no duration,
 * and the card then shows everything except the length. Never a reason to
 * block an upload — the server does not need this value for anything.
 */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };

    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () =>
      done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null),
    );
    audio.addEventListener("error", () => done(null));
    // A file the browser stalls on must not hold the upload hostage.
    setTimeout(() => done(null), 4000);
    audio.src = url;
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `2026-08-07T09:12:00Z` -> `7 Aug, 9:12 am`, in the reader's own timezone. */
function formatUploadedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(",", " ·");
}

function HeadphonesIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path
        d="M2 8V6a4 4 0 0 1 8 0v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <rect x="1.2" y="7.2" width="2.4" height="3.2" rx="1.1" fill="currentColor" />
      <rect x="8.4" y="7.2" width="2.4" height="3.2" rx="1.1" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path
        d="M6 2.5v7M2.5 6h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
