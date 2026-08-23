"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ExternalLink, ImageOff, Link2, Loader2, Upload } from "lucide-react";

import { demoImageSrc } from "./demoImage";
import {
  DEMO_IMAGE_ACCEPT,
  DEMO_IMAGE_EXTENSIONS,
  MAX_DEMO_IMAGE_BYTES,
} from "@/lib/demoImageRules";
import {
  DEMO_LINK_LABELS,
  demoUrlHost,
  isValidDemoUrl,
  type DemoLinkField,
  type DemoSummary,
} from "@/lib/demoWebsiteRules";

/**
 * The three cells the Demo Websites view adds to a lead row: the image, and one
 * for each of the two demo links.
 *
 * **A shortcut, not a second feature**, on exactly the terms
 * `RowRecordingButton` sets for audio on the worklist: everything that decides
 * anything lives elsewhere and stays there — the accepted formats and the size
 * limit in `lib/demoImageRules.ts`, the URL rule in `lib/demoWebsiteRules.ts`,
 * and who may write either in the two route handlers. Setting a link from a row
 * and setting it from the lead workspace are the same request.
 *
 * They replace the Audio cell rather than sitting beside it, and that is the
 * point: **the demo view has no audio control anywhere.** A lead's recording is
 * untouched, still uploaded and played from the worklist and the workspace; it
 * is simply not what this view is for.
 *
 * Nothing here is a permission. Both writes go to endpoints behind
 * `apiModule("demoWebsites")`, which re-reads the caller's module from the
 * `users` row on every request — a hand-built request from an agent without it
 * gets a 403 whatever this file draws.
 */

/** How long the tick stays up before the cell settles. */
const SUCCESS_MS = 2000;

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * The image cell: a thumbnail when there is one, an upload glyph when there is
 * not.
 *
 * 28px, matching the audio button it stands in for, because it is the same kind
 * of thing — one action beside the row, not a feature of the list. Replacing
 * and removing live in the workspace, where there is room to look at the image
 * before deciding; this cell adds one and shows one.
 */
export function DemoImageCell({
  leadId,
  leadName,
  demo,
  onSaved,
}: {
  leadId: string;
  leadName: string;
  /** null when the lead has no demo metadata at all — the usual case. */
  demo: DemoSummary | null;
  onSaved: (leadId: string, demo: DemoSummary) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function settle(next: Phase, after = SUCCESS_MS) {
    setPhase(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase({ kind: "idle" }), after);
  }

  async function upload(file: File) {
    // Said before the bytes travel rather than after. The server refuses this
    // too (413), but making somebody wait for five megabytes to upload before
    // being told is a worse way to say the same thing.
    if (file.size > MAX_DEMO_IMAGE_BYTES) {
      settle(
        {
          kind: "error",
          message: `Over the ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB limit.`,
        },
        5000,
      );
      return;
    }

    setPhase({ kind: "busy" });
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
        // The API's refusals are written for a person — "Upload a jpg, png,
        // webp image" — so they are shown as-is rather than replaced.
        settle({ kind: "error", message: payload.message ?? "That upload was refused." }, 5000);
        return;
      }

      onSaved(leadId, payload.demo);
      settle({ kind: "done" });
    } catch {
      settle({ kind: "error", message: "Could not reach the server." }, 5000);
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const image = demo?.image ?? null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={DEMO_IMAGE_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      {phase.kind === "error" && (
        // Floated out of a cell only wide enough for the control itself, the
        // same trick the audio button uses for its failures.
        <span
          role="alert"
          className="absolute left-1 top-full z-20 mt-0.5 w-max max-w-[15rem] rounded border border-danger-line bg-danger-bg px-1.5 py-1 text-meta text-danger shadow-e2"
        >
          {phase.message}
        </span>
      )}

      <button
        type="button"
        // `row-inner-link` lifts it above the row's own click overlay, or
        // choosing a file would open the lead workspace instead.
        className="row-inner-link relative flex h-7 w-9 items-center justify-center overflow-hidden rounded border border-line bg-recessed text-fg-4 transition-colors hover:border-line-2 hover:text-fg-2 disabled:cursor-wait"
        disabled={phase.kind === "busy"}
        onClick={() => inputRef.current?.click()}
        title={
          image
            ? `Demo image for ${leadName} — ${image.width}×${image.height}. Click to replace.`
            : `Upload a demo image for ${leadName} (${DEMO_IMAGE_EXTENSIONS.join(", ")}, up to ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB)`
        }
        aria-label={image ? `Replace the demo image for ${leadName}` : `Upload a demo image for ${leadName}`}
      >
        {phase.kind === "busy" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
        ) : phase.kind === "done" ? (
          <Check className="h-3.5 w-3.5 text-success" strokeWidth={2.25} aria-hidden="true" />
        ) : phase.kind === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 text-danger" strokeWidth={2} aria-hidden="true" />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={demoImageSrc(leadId, demo)}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <Upload className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
    </>
  );
}

/**
 * A link cell: the host as an external link when set, "Add link" when not.
 *
 * **One component, drawn twice** - once for Demo link 1 and once for Demo link
 * 2 - told apart by `field`, which is both the property it reads off the
 * summary and the key it sends in the PATCH. Two near-identical cells differing
 * only in a property name is exactly the copy that drifts, and the server
 * treats the two links identically, so the client does too.
 *
 * Editing is inline - a text input that replaces the cell's contents - rather
 * than a dialog, because a URL is one short value and a modal to type one is
 * three interactions where one will do. Escape cancels, Enter saves, and
 * nothing is written until one of the two. The PATCH carries only this field's
 * key, so saving one link never touches the other.
 */
export function DemoLinkCell({
  leadId,
  leadName,
  demo,
  field = "demoUrl",
  onSaved,
}: {
  leadId: string;
  leadName: string;
  demo: DemoSummary | null;
  /** Which of the two demo links this cell edits. */
  field?: DemoLinkField;
  onSaved: (leadId: string, demo: DemoSummary) => void;
}) {
  const [editing, setEditing] = useState(false);
  const label = DEMO_LINK_LABELS[field];
  const [value, setValue] = useState(demo?.[field] ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  // The saved value changing underneath — another tab, a save from the
  // workspace — resets what the field is seeded with. Done during render
  // rather than in an effect so the field never paints one frame of a stale
  // value; skipped while editing, or it would fight the person typing.
  const saved = demo?.[field] ?? "";
  const [lastSaved, setLastSaved] = useState(saved);
  if (lastSaved !== saved && !editing) {
    setLastSaved(saved);
    setValue(saved);
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function commit(next: string | null) {
    setPhase({ kind: "busy" });
    try {
      const response = await fetch(`/api/leads/${leadId}/demo`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Only this cell's own key. The other link and the comments are absent
        // from the body, and the server leaves absent fields alone.
        body: JSON.stringify({ [field]: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        demo?: DemoSummary;
        message?: string;
      };

      if (!response.ok || !payload.demo) {
        setPhase({ kind: "error", message: payload.message ?? "That link was refused." });
        return;
      }

      onSaved(leadId, payload.demo);
      setLastSaved(payload.demo[field] ?? "");
      setValue(payload.demo[field] ?? "");
      setEditing(false);
      setPhase({ kind: "idle" });
    } catch {
      setPhase({ kind: "error", message: "Could not reach the server." });
    }
  }

  if (editing) {
    const trimmed = value.trim();
    // The same validator the server runs, for the message rather than for the
    // protection. An empty field is a deliberate clear and is always allowed.
    const valid = trimmed === "" || isValidDemoUrl(trimmed);

    return (
      <span className="row-inner-link relative flex items-center gap-1">
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (phase.kind === "error") setPhase({ kind: "idle" });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (valid) void commit(trimmed === "" ? null : trimmed);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setValue(saved);
              setEditing(false);
              setPhase({ kind: "idle" });
            }
          }}
          onBlur={() => {
            // Blur cancels rather than saves. A URL half-typed and clicked away
            // from is not a value anybody meant to commit, and Enter is right
            // there.
            if (phase.kind === "busy") return;
            setValue(saved);
            setEditing(false);
          }}
          placeholder="https://example-demo.com"
          aria-label={`${label} for ${leadName}`}
          aria-invalid={!valid}
          autoCapitalize="none"
          spellCheck={false}
          className="ui-field h-7 w-full min-w-0 px-1.5 text-caption"
        />
        {!valid && (
          <span
            role="alert"
            className="absolute left-0 top-full z-20 mt-0.5 w-max max-w-[16rem] rounded border border-danger-line bg-danger-bg px-1.5 py-1 text-meta text-danger shadow-e2"
          >
            Use an http:// or https:// address.
          </span>
        )}
        {phase.kind === "error" && (
          <span
            role="alert"
            className="absolute left-0 top-full z-20 mt-0.5 w-max max-w-[16rem] rounded border border-danger-line bg-danger-bg px-1.5 py-1 text-meta text-danger shadow-e2"
          >
            {phase.message}
          </span>
        )}
      </span>
    );
  }

  const href = demo?.[field] ?? null;

  if (!href) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`Add ${label.toLowerCase()} for ${leadName}`}
        className="row-inner-link inline-flex items-center gap-1 rounded text-caption text-fg-4 transition-colors hover:text-accent"
      >
        <Link2 className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        Add link
      </button>
    );
  }

  return (
    <span className="row-inner-link flex min-w-0 items-center gap-1">
      {/*
       * The host rather than the whole URL: the cell has no room for a path,
       * and the full address is in the tooltip and the workspace.
       *
       * `target="_blank"` because the whole point is to leave the portal
       * without losing the list, and `rel="noopener noreferrer"` because a page
       * opened this way can otherwise reach back through `window.opener`. The
       * href was validated to be http or https before it was stored, so there
       * is no `javascript:` for this anchor to run.
       */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`${href} — open in a new tab`}
        className="group/link inline-flex min-w-0 items-center gap-1 rounded text-caption text-fg-2 transition-colors hover:text-accent"
      >
        <span className="truncate underline decoration-line-2 underline-offset-[3px] group-hover/link:decoration-accent">
          {demoUrlHost(href)}
        </span>
        <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100" strokeWidth={2} aria-hidden="true" />
      </a>
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${label.toLowerCase()} for ${leadName}`}
        title="Edit"
        className="shrink-0 rounded p-0.5 text-fg-4 opacity-0 transition-opacity hover:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Link2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </span>
  );
}

/** The empty-image glyph, for the workspace panel's placeholder. */
export function NoDemoImage({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-2 bg-recessed px-6 py-8 text-fg-4">
      <ImageOff className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-caption">{label}</p>
    </div>
  );
}
