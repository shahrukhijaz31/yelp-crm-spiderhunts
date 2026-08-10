"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AudioLines, Check, Loader2, Upload } from "lucide-react";

import { formatSize, postWithProgress, readDuration } from "./recordingUpload";
import {
  ACCEPTED_EXTENSIONS,
  MAX_RECORDING_BYTES,
  type RecordingSummary,
} from "@/lib/recordingRules";

/**
 * The worklist's quick-upload button: one 28px icon beside the status chip.
 *
 * **A shortcut, not a second feature.** Everything that decides anything about
 * a recording is somewhere else and stays there — the size limit and the format
 * list in `lib/recordingRules.ts`, the transport in `./recordingUpload`, and who
 * may upload, hear or replace one in `lib/recordings.ts`, enforced by the same
 * `POST /api/meetings/[leadId]/recording` the lead workspace posts to. Uploading
 * here and uploading there are the same request; the workspace remains the place
 * a recording is played, replaced or deleted.
 *
 * The button is for the agent who already knows which file goes with which lead
 * and does not want to open a lead to say so. So it is one click to the file
 * picker and one file to a finished upload — no panel, no dialog, no navigation.
 * The compliance reminder the two full surfaces show beside their file input has
 * nowhere to live at this size, so it rides in the tooltip, which is the text an
 * agent reads immediately before choosing a file.
 *
 * Three things are deliberately *not* drawn here:
 *
 *   Ineligible leads get nothing. A recording attaches to a meeting, and "a
 *   meeting" in this app is derived (`isMeetingLead` — interested, or a date in
 *   the diary); the server refuses anything else with a 400. An arrow that
 *   always fails is worse than no arrow, and in the New queue that would be a
 *   column of them.
 *
 *   A recording someone else uploaded is a flat glyph rather than a button. The
 *   server would refuse the replace (`canManage`), and it is the server's word
 *   that decides it, not a role check repeated in the browser.
 *
 *   Delete. Removing a client conversation on a single click, from a row, with
 *   the confirm dialog as the only thing between it and a mis-click, is not a
 *   quick action. It stays in the workspace.
 */

const ACCEPT = [
  ...ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`),
  "audio/*",
].join(",");

/** How long the tick stays up before the button settles into "attached". */
const SUCCESS_MS = 2400;

/**
 * The same reminder `CallRecordingPanel` and `RecordingCell` print beside their
 * file input, worded identically. It is a reminder of the agent's own
 * obligation, not advice about what the law is.
 */
const AUTHORIZED_HINT = "Only upload recordings you are authorized to record and share.";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; progress: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

export default function RowRecordingButton({
  leadId,
  leadName,
  recording,
  eligible,
  onSaved,
}: {
  leadId: string;
  leadName: string;
  /** null when there is none, or when it belongs to another agent. */
  recording: RecordingSummary | null;
  /** Whether the saved lead is on the meetings agenda (`isMeetingLead`). */
  eligible: boolean;
  /** Hands the saved summary back so the row — and only the row — updates. */
  onSaved: (recording: RecordingSummary) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // The success tick clears itself, so it has to be cancelled if the row is
  // unmounted first — a page turn while an upload finishes is exactly that.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  async function upload(file: File) {
    if (file.size > MAX_RECORDING_BYTES) {
      // Refused here as well as on the server, so the agent is told before
      // spending a minute uploading something that will be rejected on arrival.
      // The server check is the one that counts.
      setPhase({
        kind: "error",
        message: `${file.name} is ${formatSize(file.size)} — the limit is ${formatSize(MAX_RECORDING_BYTES)}.`,
      });
      return;
    }

    setPhase({ kind: "busy", progress: 0 });

    const body = new FormData();
    body.append("file", file);
    // Read from the file itself so the length is known without a round trip.
    // The server treats it as display metadata and clamps it.
    const duration = await readDuration(file);
    if (duration !== null) body.append("durationSeconds", String(Math.round(duration)));

    try {
      const saved = await postWithProgress(
        `/api/meetings/${encodeURIComponent(leadId)}/recording`,
        body,
        (progress) => setPhase({ kind: "busy", progress }),
      );
      onSaved(saved);
      setPhase({ kind: "done" });
      settleTimer.current = setTimeout(() => setPhase({ kind: "idle" }), SUCCESS_MS);
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Upload failed. Try again.",
      });
    }
  }

  // Nothing to offer and nothing to show: no meeting to attach audio to.
  if (!recording && !eligible) return null;

  // Someone else's recording. Visible as a state, not offered as an action.
  if (recording && !recording.canManage) {
    return (
      <span
        title={`Call recording uploaded by ${recording.uploadedBy.name}`}
        className="inline-flex h-7 w-7 items-center justify-center text-info opacity-70"
      >
        <AudioLines className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">
          {leadName} has a call recording uploaded by {recording.uploadedBy.name}
        </span>
      </span>
    );
  }

  const busy = phase.kind === "busy";
  const percent = busy ? Math.round(phase.progress * 100) : 0;

  const { tone, title, hint, icon } = describe(phase, recording !== null);

  return (
    <>
      {/*
       * The picker itself. Opened from the button rather than shown, because a
       * file input in a table row is a control the width of the column and this
       * cell is 28px wide.
       */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          // Cleared straight away so choosing the *same* file after a failure
          // still fires a change event and retries the upload.
          event.target.value = "";
          if (file) void upload(file);
        }}
      />

      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        // Two lines: what the button does, and — where there is one — the
        // reminder the two full upload surfaces print beside their file input.
        // A row has no room for that sentence anywhere else, and this is the
        // moment it should be read.
        title={hint ? `${title}\n${hint}` : title}
        aria-label={`${title} — ${leadName}`}
        // `row-inner-link` lifts it above the row-wide link overlay; without it
        // the click would open the lead workspace, which is the one thing this
        // button exists to avoid. The stopPropagation pair matches the other
        // in-row controls.
        onClick={(event) => {
          event.stopPropagation();
          if (phase.kind === "error") setPhase({ kind: "idle" });
          inputRef.current?.click();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className={`row-inner-link relative inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-md transition-[color,background-color,opacity] hover:bg-line focus-visible:bg-line focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-default ${tone}`}
      >
        {/* Determinate progress, drawn as a quiet sweep behind the spinner
            rather than as a bar: there is no room for a bar at this size, and
            an indeterminate spinner alone cannot say how far along a 25MB
            upload is. */}
        {busy && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-md opacity-20"
            style={{
              background: `conic-gradient(var(--c-accent) ${percent}%, transparent 0)`,
            }}
          />
        )}
        <span className="relative flex">{icon}</span>
      </button>

      {/*
       * A failed upload says why, without hovering and without a column wide
       * enough to hold a sentence: a small bubble floated *leftwards* out of
       * this cell, over the columns beside it. Leftwards because the cell is
       * near the right edge of a table that scrolls sideways, and a message
       * that opens off-screen is the one that most needed reading.
       *
       * It stays until the agent retries — an upload that failed is not
       * something to let scroll quietly away — and z-8 puts it above the
       * row-wide link overlay so its text is selectable rather than a click
       * into the workspace.
       */}
      {phase.kind === "error" && (
        <span
          role="alert"
          className="absolute right-full top-1/2 z-[8] mr-1 max-w-[260px] -translate-y-1/2 rounded-md border border-danger-line bg-danger-bg px-2 py-1 text-meta leading-snug text-danger shadow-sm"
        >
          {phase.message}
        </span>
      )}

      {/* Progress and success announced rather than drawn — the spinner, the
          sweep and the tick say it to everyone else. A failure is not here: the
          bubble above is a live `role="alert"` and would be read out twice. */}
      <span role="status" aria-live="polite" className="sr-only">
        {busy
          ? `Uploading recording for ${leadName}, ${percent}%`
          : phase.kind === "done"
            ? `Recording uploaded for ${leadName}`
            : ""}
      </span>
    </>
  );
}

/**
 * One state, one glyph, one sentence — kept together so the tooltip and the
 * icon can never describe different things.
 *
 * Attached is `info` rather than the app's accent: red is reserved for the
 * primary action and for anything time-critical, and a column of red glyphs
 * would read as a column of problems.
 */
function describe(
  phase: Phase,
  attached: boolean,
): { tone: string; title: string; hint?: string; icon: React.ReactNode } {
  switch (phase.kind) {
    case "busy":
      return {
        tone: "text-fg-3",
        title: `Uploading… ${Math.round(phase.progress * 100)}%`,
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />,
      };
    case "done":
      return {
        tone: "text-success",
        title: "Recording uploaded",
        icon: <Check className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />,
      };
    case "error":
      return {
        tone: "text-danger",
        title: `${phase.message} Click to try again.`,
        icon: <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />,
      };
    default:
      return attached
        ? {
            tone: "text-info",
            title: "Call recording attached — click to replace",
            hint: AUTHORIZED_HINT,
            icon: <AudioLines className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />,
          }
        : {
            // Quiet until the row is under the cursor, like the WhatsApp glyph
            // beside the phone number: an arrow at full strength on every row
            // of a column is chrome, and the column is not what an agent is
            // scanning for.
            tone: "text-fg-4 opacity-60 hover:text-fg-2 hover:opacity-100 focus-visible:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100",
            title: "Upload call recording",
            hint: AUTHORIZED_HINT,
            icon: <Upload className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />,
          };
  }
}
