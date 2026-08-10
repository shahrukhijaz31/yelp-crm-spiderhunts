"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AudioLines, Info, Upload } from "lucide-react";

import RecordingPlayer, { formatClock } from "./RecordingPlayer";
import {
  formatSize,
  formatUploadedAt,
  postWithProgress,
  readDuration,
} from "./recordingUpload";
import {
  ACCEPTED_EXTENSIONS,
  MAX_RECORDING_BYTES,
  type RecordingSummary,
} from "@/lib/recordingRules";

/**
 * The lead workspace's call recording section.
 *
 * **Presentation only.** Every rule about recordings is somewhere else and
 * stays there: the size limit and the accepted formats come from
 * `lib/recordingRules.ts`, the transport from `./recordingUpload`, and who may
 * upload, hear, replace or delete one is decided by `lib/recordings.ts` against
 * the session row — this component draws the answer it is given. `canManage`
 * on the summary is the server's word for "you may replace or delete this",
 * and the Replace and Delete buttons are drawn from it rather than from a role
 * check written a second time here.
 *
 * The one thing worth stating in the UI is the *eligibility* rule, because it
 * is otherwise invisible: a recording attaches to a meeting, and "a meeting" in
 * this app is derived (`isMeetingLead` — interested, or a date in the diary).
 * A lead with neither is refused by the server with a message nobody wants to
 * discover after choosing a file, so the panel says so up front instead.
 *
 * Note that eligibility is judged on the **saved** lead, not on the draft: the
 * upload posts immediately and the server reads the row, so a status the agent
 * has picked but not yet saved does not yet make this lead a meeting.
 */

type Notice = { tone: "ok" | "error"; message: string } | null;

export default function CallRecordingPanel({
  leadId,
  leadName,
  recording,
  eligible,
  onSaved,
  onDeleted,
}: {
  leadId: string;
  leadName: string;
  /** null when there is none, or when it belongs to another agent. */
  recording: RecordingSummary | null;
  /** Whether the *saved* lead is on the meetings agenda (`isMeetingLead`). */
  eligible: boolean;
  onSaved: (recording: RecordingSummary) => void;
  onDeleted: () => void;
}) {
  const reduced = useReducedMotion();
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
      onDeleted();
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
    <section aria-labelledby="ws-recording" className="ws-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ws-recording" className="eyebrow">
          Call recording
        </h2>
        {recording?.canManage && !open && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setOpen(true);
              }}
              disabled={busy}
              className="ui-btn ui-btn-ghost h-7 px-2 text-caption"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              aria-busy={busy}
              className="ui-btn ui-btn-ghost h-7 px-2 text-caption hover:text-danger"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="mt-2.5">
        {recording ? (
          <div className="rounded-lg border border-line bg-recessed/60 p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
              <AudioLines
                className="h-3.5 w-3.5 shrink-0 text-accent"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate font-medium text-fg">
                Call with {leadName}
              </span>
              {recording.durationSeconds !== null && (
                <>
                  <span aria-hidden="true" className="text-fg-4">·</span>
                  <span className="tnum font-mono text-fg-3">
                    {formatClock(recording.durationSeconds)}
                  </span>
                </>
              )}
            </div>

            <div className="mt-2.5 flex">
              <RecordingPlayer
                // Keyed by the recording, so replacing one mounts a fresh
                // transport instead of leaving the scrubber where the previous
                // file's playhead was.
                key={recording.id}
                src={`/api/meetings/${encodeURIComponent(leadId)}/recording/stream`}
                fallbackDuration={recording.durationSeconds}
                label={leadName}
              />
            </div>

            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-fg-3">
              <span className="truncate">{recording.fileName}</span>
              <span aria-hidden="true">·</span>
              <span className="tnum font-mono">{formatSize(recording.fileSize)}</span>
              <span aria-hidden="true">·</span>
              <span>
                Uploaded by <span className="text-fg-2">{recording.uploadedBy.name}</span>{" "}
                {formatUploadedAt(recording.uploadedAt)}
              </span>
            </p>
          </div>
        ) : (
          !open && (
            <div className="ws-empty">
              <p className="text-ui text-fg-3">No recording uploaded</p>
              {eligible ? (
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="ui-btn ui-btn-secondary mt-2.5 h-9"
                >
                  <Upload className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                  Upload call audio
                </button>
              ) : (
                <p className="mt-2 flex items-start gap-1.5 text-caption leading-relaxed text-fg-3">
                  <Info
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-4"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span>
                    Save this lead as{" "}
                    <span className="text-fg-2">Called - Interested</span>, or book a
                    date for it, before attaching a recording.
                  </span>
                </p>
              )}
            </div>
          )
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduced ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 0.61, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2.5 rounded-lg border border-line bg-recessed/60 p-3">
              {/* The compliance reminder sits on the action itself rather than
                  in a tooltip or a page footer: it is the sentence the agent
                  should read at the moment they pick a file, and it is
                  deliberately a reminder of their own obligation, not advice
                  about what the law is. */}
              <p className="text-caption text-fg-2">
                Only upload recordings you are authorized to record and share.
              </p>

              <input
                ref={inputRef}
                type="file"
                accept={[
                  ...ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`),
                  "audio/*",
                ].join(",")}
                disabled={busy}
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                className="mt-2.5 max-w-full text-caption text-fg-2 file:mr-2.5 file:cursor-pointer file:rounded-lg file:border file:border-line-2 file:bg-surface file:px-2.5 file:py-1.5 file:text-caption file:font-medium file:text-fg-2 hover:file:border-fg-4 hover:file:bg-hover hover:file:text-fg"
              />

              <label className="mt-2.5 flex items-start gap-2 text-caption text-fg-2">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--c-accent)]"
                />
                <span>I am authorized to record this call and to share it with the team.</span>
              </label>

              {progress !== null && (
                <div className="mt-2.5">
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                    aria-label="Upload progress"
                    className="h-1 w-full overflow-hidden rounded-full bg-line-2"
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
                  className="ui-btn ui-btn-primary h-9"
                >
                  {busy ? "Uploading…" : recording ? "Replace recording" : "Upload recording"}
                </button>
                <button
                  type="button"
                  onClick={closePanel}
                  disabled={busy}
                  className="ui-btn ui-btn-ghost h-9"
                >
                  Cancel
                </button>
                <span className="text-meta text-fg-3">
                  {ACCEPTED_EXTENSIONS.join(", ")} · up to {formatSize(MAX_RECORDING_BYTES)}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {notice && (
        <p
          className={`mt-2 text-caption ${notice.tone === "error" ? "text-danger" : "text-success"}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
    </section>
  );
}
