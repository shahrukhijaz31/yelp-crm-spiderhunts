"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Trash2, Upload, X } from "lucide-react";

import { NoDemoImage } from "./DemoCells";
import { demoImageSrc } from "./demoImage";
import {
  DEMO_IMAGE_ACCEPT,
  DEMO_IMAGE_EXTENSIONS,
  MAX_DEMO_IMAGE_BYTES,
} from "@/lib/demoImageRules";
import { isValidDemoUrl, type DemoSummary } from "@/lib/demoWebsiteRules";
import { formatFileSize } from "@/lib/screenshotViewerRules";

/**
 * The demo half of a lead, inside the lead workspace.
 *
 * **It sits exactly where the call recording sits on the worklist**, and the
 * two are mutually exclusive: the workspace draws `CallRecordingPanel` in the
 * Leads section and this in the Demo Websites section. Everything above it —
 * the lead's name, phone, address, owner, status, callback, meeting and notes —
 * is the same component drawing the same lead either way, which is the whole
 * architecture in one screen: **a demo website is a lead, plus these two
 * fields.**
 *
 * There is no audio here and no reference to one. This panel does not import
 * `CallRecordingPanel`, does not read a `RecordingSummary`, and the workspace
 * does not render both.
 *
 * ---------------------------------------------------------------------------
 * Saving
 * ---------------------------------------------------------------------------
 * Both fields save on their own, immediately, and deliberately **do not join
 * the workspace's Save bar**. That bar commits lead fields — status, notes, the
 * callback — in one PATCH against `leads`; these two are a different row in a
 * different table behind a different permission, and folding them in would mean
 * one Save button whose failure modes are two unrelated endpoints. An upload
 * that posts the moment a file is chosen is also what the row cell does, so the
 * two places behave the same way.
 *
 * Nothing here is a permission. Both writes go to endpoints behind
 * `apiModule("demoWebsites")`, which re-reads the caller's module from the
 * `users` row on every request.
 */
export default function DemoWebsitePanel({
  leadId,
  leadName,
  demo,
  onChanged,
}: {
  leadId: string;
  leadName: string;
  /** Null when the lead has no demo image and no demo link yet. */
  demo: DemoSummary | null;
  onChanged: (demo: DemoSummary | null) => void;
}) {
  const [busy, setBusy] = useState<"image" | "link" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const saved = demo?.demoUrl ?? "";
  const [link, setLink] = useState(saved);
  const fileRef = useRef<HTMLInputElement>(null);

  // The saved link changing underneath — a save from the row behind this
  // window — reseeds the field. During render rather than in an effect so it
  // never paints one frame of a stale value.
  const [lastSaved, setLastSaved] = useState(saved);
  if (lastSaved !== saved) {
    setLastSaved(saved);
    setLink(saved);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && zoomed) {
        event.stopPropagation();
        setZoomed(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [zoomed]);

  const trimmed = link.trim();
  const linkValid = trimmed === "" || isValidDemoUrl(trimmed);
  const linkDirty = trimmed !== saved;

  const image = demo?.image ?? null;
  const src = useMemo(() => demoImageSrc(leadId, demo), [leadId, demo]);

  async function uploadImage(file: File) {
    if (file.size > MAX_DEMO_IMAGE_BYTES) {
      setError(`That image is over the ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB limit.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    setBusy("image");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/leads/${leadId}/demo/image`, {
        method: "POST",
        body: form,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        demo?: DemoSummary;
        message?: string;
      };

      if (!response.ok || !payload.demo) {
        setError(payload.message ?? "That image could not be saved.");
        return;
      }
      onChanged(payload.demo);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeImage() {
    setBusy("remove");
    setError(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/demo/image`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as {
        demo?: DemoSummary | null;
        message?: string;
        imageOrphaned?: boolean;
      };

      if (!response.ok) {
        setError(payload.message ?? "That image could not be removed.");
        return;
      }
      // The server says so when the row was cleared but the file survived.
      // Shown rather than swallowed: a removal that half worked should not read
      // as a clean one.
      if (payload.imageOrphaned && payload.message) setError(payload.message);
      onChanged(payload.demo ?? null);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function saveLink() {
    if (!linkValid) return;

    setBusy("link");
    setError(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/demo`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ demoUrl: trimmed === "" ? null : trimmed }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        demo?: DemoSummary;
        message?: string;
      };

      if (!response.ok || !payload.demo) {
        // The API's refusals are written for a person — "Demo links must start
        // with http:// or https://" — so they are shown as-is.
        setError(payload.message ?? "That link could not be saved.");
        return;
      }
      onChanged(payload.demo);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="ws-demo" className="ws-block">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ws-demo" className="eyebrow">
          Demo website
        </h2>
        <span className="text-meta text-fg-4">Saved on its own, not with the bar below</span>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2.5 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-caption text-danger"
        >
          {error}
        </p>
      )}

      {/* --- the image --------------------------------------------------- */}
      <div className="mt-3">
        {image ? (
          <button
            type="button"
            onClick={() => setZoomed(true)}
            aria-label={`View the demo image for ${leadName} at full size`}
            className="group block w-full overflow-hidden rounded-lg border border-line bg-recessed outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
          >
            {/* A plain <img> rather than next/image: these bytes come from an
                authenticated route, so the optimiser could not fetch them, and
                the browser's own request is the one carrying the session
                cookie. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={`Demo image for ${leadName}`}
              width={image.width}
              height={image.height}
              className="max-h-64 w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
            />
          </button>
        ) : (
          <NoDemoImage label="No demo image yet." />
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={DEMO_IMAGE_ACCEPT}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadImage(file);
            }}
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => fileRef.current?.click()}
            className="ui-btn ui-btn-secondary"
          >
            {busy === "image" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Upload className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            )}
            {image ? "Replace image" : "Upload image"}
          </button>

          {image && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void removeImage()}
              className="ui-btn ui-btn-ghost text-fg-3 hover:text-danger"
            >
              {busy === "remove" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              )}
              Remove
            </button>
          )}

          <span className="text-meta text-fg-4">
            {image
              ? `${image.width}×${image.height} · ${formatFileSize(image.fileSize)}`
              : `${DEMO_IMAGE_EXTENSIONS.join(", ")} · up to ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB`}
          </span>
        </div>
      </div>

      {/* --- the link ----------------------------------------------------- */}
      <div className="mt-4">
        <label className="field-label" htmlFor={`demo-link-${leadId}`}>
          Demo link
        </label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            id={`demo-link-${leadId}`}
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveLink();
              }
            }}
            placeholder="https://example-demo.com"
            aria-invalid={!linkValid}
            autoCapitalize="none"
            spellCheck={false}
            className={`ui-field min-w-0 flex-1 ${linkDirty ? "!border-warning-line !bg-warning-bg/40" : ""}`}
          />

          <button
            type="button"
            disabled={busy !== null || !linkValid || !linkDirty}
            onClick={() => void saveLink()}
            className="ui-btn ui-btn-primary"
          >
            {busy === "link" ? "Saving…" : "Save link"}
          </button>

          {/*
           * Open Demo, and only for the *saved* link — not for whatever is
           * currently in the field. Opening a half-typed address in a new tab
           * is a broken page in front of a client, and the button is here to be
           * pressed during a call.
           *
           * `target="_blank"` to leave the portal without losing the lead, and
           * `rel="noopener noreferrer"` because a page opened this way can
           * otherwise reach back through `window.opener`. The href was
           * validated to be http or https before it was stored, so there is no
           * `javascript:` for this anchor to run.
           */}
          {demo?.demoUrl && (
            <a
              href={demo.demoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`${demo.demoUrl} — open in a new tab`}
              className="ui-btn ui-btn-secondary"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Open Demo
            </a>
          )}
        </div>

        {!linkValid && (
          <p role="alert" className="mt-1.5 text-meta text-danger">
            Use an http:// or https:// address — a bare domain is fine and is saved as https.
          </p>
        )}
        {linkValid && trimmed === "" && saved !== "" && (
          <p className="mt-1.5 text-meta text-fg-4">Saving an empty field removes the link.</p>
        )}
      </div>

      {/* --- the image at full size --------------------------------------- */}
      {zoomed && image && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8">
          <button
            type="button"
            aria-label="Close full-size image"
            onClick={() => setZoomed(false)}
            className="absolute inset-0 cursor-zoom-out bg-base/85 backdrop-blur-sm"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={`Demo image for ${leadName}, full size`}
            className="pop-in relative max-h-full max-w-full rounded-lg border border-line object-contain shadow-e3"
          />
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close full-size image"
            className="ui-btn ui-btn-secondary absolute right-4 top-4 h-8 w-8 !px-0"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}
