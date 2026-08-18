"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff, Trash2, Upload, X } from "lucide-react";

import { demoImageSrc } from "./demoImage";
import {
  DEMO_IMAGE_ACCEPT,
  DEMO_IMAGE_EXTENSIONS,
  MAX_DEMO_IMAGE_BYTES,
} from "@/lib/demoImageRules";
import {
  DEMO_WEBSITE_STATUSES,
  DEMO_WEBSITE_STATUS_LABELS,
  DEFAULT_DEMO_WEBSITE_STATUS,
  DemoWebsiteError,
  MAX_NOTES_LENGTH,
  normaliseDemoUrl,
  type DemoWebsiteCard,
  type DemoWebsiteStatus,
} from "@/lib/demoWebsiteRules";

/**
 * Adding a demo website, and editing one.
 *
 * **One component for both.** A create form and an edit form that differ only
 * in their initial values and their verb are two components that drift: the day
 * a field is added, one of them gets it. `demoWebsite` being null is the whole
 * difference — it decides POST or PATCH, the heading, and whether the image
 * section is offered at all.
 *
 * **The image is a second request, deliberately.** A new demo website has no id
 * until it has been created, and an image needs one to be filed against; so
 * Save creates the record and, if a file was chosen, uploads it immediately
 * afterwards against the id that came back. The alternative — one multipart
 * request that creates a row and stores bytes together — would mean a failed
 * upload rolling back a record the administrator had already filled in.
 *
 * If that second request fails the record still exists and the form says so
 * plainly rather than reporting a success that was only half true. The
 * administrator is left on a saved record with no image, which is a state the
 * Edit form can fix in one click.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a permission
 * ---------------------------------------------------------------------------
 * This component is only rendered for an administrator, and that is tidiness.
 * `POST`, `PATCH` and both image verbs are each behind `apiAdmin()`, which
 * re-reads the caller's role from Postgres on every request — an agent who
 * reconstructs these requests by hand gets a 403 whatever this file does.
 *
 * The URL is checked here too, by the same `normaliseDemoUrl` the server runs.
 * That copy exists to say "that is not a web address" without a round trip; it
 * is a convenience and it is not what protects anything, because the value that
 * reaches the column is the one the server validated.
 */

type Draft = {
  name: string;
  clientName: string;
  demoUrl: string;
  phone: string;
  email: string;
  status: DemoWebsiteStatus;
  notes: string;
};

function draftFrom(demoWebsite: DemoWebsiteCard | null): Draft {
  return {
    name: demoWebsite?.name ?? "",
    clientName: demoWebsite?.clientName ?? "",
    demoUrl: demoWebsite?.demoUrl ?? "",
    phone: demoWebsite?.phone ?? "",
    email: demoWebsite?.email ?? "",
    status: demoWebsite?.status ?? DEFAULT_DEMO_WEBSITE_STATUS,
    notes: demoWebsite?.notes ?? "",
  };
}

export default function DemoWebsiteForm({
  demoWebsite,
  onSaved,
  onClose,
}: {
  /** Null to create. An existing record to edit. */
  demoWebsite: DemoWebsiteCard | null;
  /** The saved record, and a sentence for the list's notice bar. */
  onSaved: (saved: DemoWebsiteCard, message: string) => void;
  onClose: () => void;
}) {
  const editing = demoWebsite !== null;

  const [draft, setDraft] = useState<Draft>(() => draftFrom(demoWebsite));
  const [file, setFile] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * An object URL for the chosen file, so the preview shows the bytes that are
   * about to be sent rather than a filename.
   *
   * Derived rather than held in state: the URL is a pure function of the file,
   * and computing it in an effect would mean one render showing the old preview
   * under the new choice. The effect below only cleans up — an object URL that
   * is never revoked holds the whole file in memory for the life of the tab.
   */
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    const { body } = document;
    const overflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function chooseFile(chosen: File | null) {
    setError(null);
    if (chosen && chosen.size > MAX_DEMO_IMAGE_BYTES) {
      // Said before the upload rather than after: the server refuses this too
      // (413), but making somebody wait for five megabytes to travel before
      // being told is a worse way to say the same thing.
      setError(
        `That image is over the ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB limit.`,
      );
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(chosen);
    if (chosen) setRemoveImage(false);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setError(null);

    // The same validator the server runs, for the message rather than for the
    // protection. A refusal here costs no round trip; a refusal there is what
    // decides what is stored.
    try {
      normaliseDemoUrl(draft.demoUrl);
    } catch (problem) {
      setError(problem instanceof DemoWebsiteError ? problem.message : "That demo link is not valid.");
      return;
    }

    setSaving(true);

    try {
      const body = {
        name: draft.name,
        clientName: draft.clientName,
        demoUrl: draft.demoUrl,
        phone: draft.phone,
        email: draft.email,
        status: draft.status,
        notes: draft.notes,
      };

      const response = await fetch(
        editing ? `/api/demo-websites/${demoWebsite.id}` : "/api/demo-websites",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        demoWebsite?: DemoWebsiteCard;
        message?: string;
      };

      if (!response.ok || !payload.demoWebsite) {
        // The API's validation messages are written for this form — "Demo links
        // must start with http:// or https://" — so they are shown as-is.
        setError(payload.message ?? "That could not be saved.");
        return;
      }

      let saved = payload.demoWebsite;
      let imageNote = "";

      if (file) {
        const form = new FormData();
        form.append("file", file);
        const upload = await fetch(`/api/demo-websites/${saved.id}/image`, {
          method: "POST",
          body: form,
        });
        const uploadPayload = (await upload.json().catch(() => ({}))) as {
          demoWebsite?: DemoWebsiteCard;
          message?: string;
        };

        if (!upload.ok || !uploadPayload.demoWebsite) {
          // The record saved and the image did not. Said plainly, and the form
          // stays open on a record that now exists so the retry is one click.
          setError(
            `${editing ? "The changes were saved" : "The demo website was created"}, but the image could not be uploaded: ${uploadPayload.message ?? "the upload was refused."}`,
          );
          onSaved(saved, "");
          setFile(null);
          if (fileRef.current) fileRef.current.value = "";
          return;
        }

        saved = uploadPayload.demoWebsite;
        imageNote = " The image was uploaded.";
      } else if (editing && removeImage && demoWebsite.image) {
        const removed = await fetch(`/api/demo-websites/${saved.id}/image`, {
          method: "DELETE",
        });
        const removedPayload = (await removed.json().catch(() => ({}))) as {
          demoWebsite?: DemoWebsiteCard;
          message?: string;
        };

        if (!removed.ok) {
          setError(
            `The changes were saved, but the image could not be removed: ${removedPayload.message ?? "the request was refused."}`,
          );
          onSaved(saved, "");
          return;
        }

        if (removedPayload.demoWebsite) saved = removedPayload.demoWebsite;
        imageNote = removedPayload.message
          ? ` ${removedPayload.message}`
          : " The image was removed.";
      }

      onSaved(
        saved,
        `${editing ? `${saved.name} has been updated.` : `${saved.name} has been added.`}${imageNote}`,
      );
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  /*
   * The stored image, when there is one and it is not pending removal.
   *
   * The *record* rather than its metadata, because both the preview and the
   * URL need it — and because narrowing on `demoWebsite` here is what lets the
   * markup below use it without re-checking that this is an edit.
   */
  const stored =
    demoWebsite !== null && demoWebsite.image !== null && !removeImage ? demoWebsite : null;

  return (
    <div className="lead-overlay" role="presentation">
      <button
        type="button"
        aria-label="Close"
        disabled={saving}
        onClick={onClose}
        className="lead-overlay-scrim"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? `Edit ${demoWebsite.name}` : "Add a demo website"}
        tabIndex={-1}
        className="lead-overlay-panel ws-window pop-in outline-none"
      >
        <header className="flex items-start gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{editing ? "Edit" : "New"}</p>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-[-0.01em] text-fg">
              {editing ? demoWebsite.name : "Add a demo website"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="ws-window-close shrink-0"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="ws-window-scroll flex flex-col gap-4 px-5 py-5">
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-danger-line bg-danger-bg px-4 py-3 text-ui text-danger"
              >
                {error}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Demo website name"
                value={draft.name}
                onChange={(value) => set("name", value)}
                required
                autoFocus
                placeholder="Example Restaurant Demo"
              />
              <Field
                label="Client / company"
                value={draft.clientName}
                onChange={(value) => set("clientName", value)}
                placeholder="ABC Restaurant"
              />
            </div>

            <Field
              label="Demo link"
              value={draft.demoUrl}
              onChange={(value) => set("demoUrl", value)}
              required
              type="url"
              inputMode="url"
              placeholder="https://example-demo.com"
              hint="http:// or https:// only. A bare domain is saved as https://."
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Phone"
                value={draft.phone}
                onChange={(value) => set("phone", value)}
                type="tel"
                placeholder="Optional"
              />
              <Field
                label="Email"
                value={draft.email}
                onChange={(value) => set("email", value)}
                type="email"
                placeholder="Optional"
              />
            </div>

            <label className="flex flex-col gap-1.5 sm:max-w-[14rem]">
              <span className="field-label">Status</span>
              <select
                value={draft.status}
                onChange={(event) => set("status", event.target.value as DemoWebsiteStatus)}
                className="ui-field cursor-pointer"
              >
                {DEMO_WEBSITE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {DEMO_WEBSITE_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            {/* --- the image ---------------------------------------------- */}
            <section className="panel-inset flex flex-col gap-3 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="field-label">Demo image</p>
                  <p className="mt-1 text-meta text-fg-4">
                    {DEMO_IMAGE_EXTENSIONS.join(", ")} · up to{" "}
                    {Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB. Stored privately and
                    served only to people who may see this demo website.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={saving}
                    className="ui-btn ui-btn-secondary"
                  >
                    <Upload className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    {stored || preview ? "Replace image" : "Upload image"}
                  </button>
                  {(stored || preview) && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        if (preview) {
                          setFile(null);
                          if (fileRef.current) fileRef.current.value = "";
                        } else {
                          setRemoveImage(true);
                        }
                      }}
                      className="ui-btn ui-btn-ghost text-fg-3 hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <input
                ref={fileRef}
                type="file"
                accept={DEMO_IMAGE_ACCEPT}
                className="sr-only"
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              />

              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview}
                  alt="The image about to be uploaded"
                  className="max-h-56 w-full rounded-md border border-line bg-recessed object-contain"
                />
              ) : stored ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={demoImageSrc(stored)}
                  alt={`Current demo image for ${stored.name}`}
                  className="max-h-56 w-full rounded-md border border-line bg-recessed object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-line-2 px-4 py-6 text-fg-4">
                  <ImageOff className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                  <p className="text-meta">
                    {removeImage ? "The image will be removed when you save." : "No image."}
                  </p>
                </div>
              )}
            </section>

            <label className="flex flex-col gap-1.5">
              <span className="field-label">Notes</span>
              <textarea
                value={draft.notes}
                onChange={(event) => set("notes", event.target.value)}
                maxLength={MAX_NOTES_LENGTH}
                rows={4}
                placeholder="Anything worth knowing before showing this to a client."
                className="ui-field h-auto resize-y py-2 leading-relaxed"
              />
            </label>
          </div>

          {/* --- save ---------------------------------------------------- */}
          {/* An explicit Save, and nothing above it writes: closing the window,
              pressing Escape or clicking the scrim discards. Nothing in this
              form saves as you type. */}
          <footer className="ws-window-foot flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="ui-btn ui-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              aria-busy={saving}
              className="ui-btn ui-btn-primary"
            >
              {saving ? "Saving…" : editing ? "Save changes" : "Save demo website"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  autoFocus,
  placeholder,
  inputMode,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  inputMode?: "url" | "tel" | "email" | "text";
  hint?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="field-label">{label}</span>
      <input
        // `type="url"` would make the browser refuse a bare `example.com`
        // before the server ever normalises it, so the demo link field takes
        // text and is validated by the rule that actually applies.
        type={type === "url" ? "text" : type}
        inputMode={inputMode}
        value={value}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="ui-field"
      />
      {hint && <span className="text-meta text-fg-4">{hint}</span>}
    </label>
  );
}
