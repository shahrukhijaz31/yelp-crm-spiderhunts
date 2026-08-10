"use client";

import type { RecordingSummary } from "@/lib/recordingRules";

/**
 * The browser half of a call-recording upload.
 *
 * Lifted out of `RecordingCell` unchanged when the lead workspace grew a
 * recording panel of its own. Two components now put audio on the same
 * endpoint, and two copies of "POST a FormData and report progress" is how the
 * two start disagreeing about what a failed upload looks like — one of them
 * would eventually gain a retry, or a different error message, and only one
 * screen would have it.
 *
 * Nothing here decides anything. The limits, the accepted formats and the
 * validation live in `lib/recordingRules.ts` and are enforced by the server;
 * this is transport and formatting.
 */

/**
 * POST a FormData and report upload progress.
 *
 * `fetch` has no equivalent — request-body progress needs either XHR or a
 * duplex stream the browsers do not agree on — and a progress bar is the whole
 * difference between a slow upload and an app that looks stuck.
 */
export function postWithProgress(
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
export function readDuration(file: File): Promise<number | null> {
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

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `2026-08-07T09:12:00Z` -> `7 Aug · 9:12 am`, in the reader's own timezone. */
export function formatUploadedAt(iso: string): string {
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
