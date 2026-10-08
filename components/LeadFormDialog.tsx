"use client";

import { useEffect, useRef, useState } from "react";

import type { LeadChangeEntry } from "@/lib/leadChangeRules";
import {
  CALL_STATUSES,
  CALL_STATUS_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  type CallStatus,
  type Lead,
  type LeadSource,
} from "@/lib/types";

/**
 * Add a lead by hand, or correct one's details.
 *
 * Two jobs, one form, because they are the same four fields: **add** is the
 * details plus an optional first outcome — a contributor usually types a lead
 * in straight after the first call, so the status, the call notes and a meeting
 * can go in at once — and **edit** is the details alone, since everything else
 * already has its own control in the workspace.
 *
 * The dialog saves for itself rather than staging into a draft: adding a lead
 * has no draft to join, and a corrected phone number should not sit unsaved
 * behind a Save button the person has already pressed once. The server is what
 * decides who may do either (`lib/leadScope.ts`); this only draws the form for
 * the roles it was told can use it.
 */
export default function LeadFormDialog({
  mode,
  lead,
  onSaved,
  onClose,
}: {
  mode: "add" | "edit";
  /** The lead being corrected. Edit mode only. */
  lead?: Lead;
  /** The saved row, and its history when the server sent it (edits do). */
  onSaved: (lead: Lead, changes: LeadChangeEntry[] | null) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(lead?.name ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [website, setWebsite] = useState(lead?.website ?? "");
  const [address, setAddress] = useState(lead?.address ?? "");
  const [sourceLink, setSourceLink] = useState(lead?.url ?? "");
  const [source, setSource] = useState<LeadSource>(lead?.source ?? "google");
  const [status, setStatus] = useState<CallStatus>("not_called");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [attendees, setAttendees] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const details = {
      name,
      phone,
      website: website.trim() || null,
      address,
      source,
      url: sourceLink.trim() || null,
    };
    const body =
      mode === "add"
        ? {
            ...details,
            status,
            notes,
            // A time with no date is in nobody's diary, so it is not sent.
            callbackDate: date || null,
            meetingTime: date && time ? time : null,
            meetingAttendees: date ? attendees.trim() || null : null,
          }
        : details;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        mode === "add" ? "/api/leads" : `/api/leads/${encodeURIComponent(lead!.id)}`,
        {
          method: mode === "add" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.message ?? `The lead could not be saved (${response.status}).`,
        );
      }
      onSaved(payload.lead as Lead, (payload.changes as LeadChangeEntry[] | undefined) ?? null);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach the server. The lead was not saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "add" ? "Add a lead" : "Edit lead details";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* A click outside is a cancel — the same thing Escape does. */}
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => !saving && onClose()}
        className="absolute inset-0 cursor-default bg-base/60 backdrop-blur-[3px]"
      />

      <form
        onSubmit={submit}
        className="panel-float pop-in relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto p-4 [--pop-origin:center]"
      >
        <h2 className="text-cell font-medium tracking-[-0.015em] text-fg">{title}</h2>
        <p className="mt-1 text-caption text-fg-3">
          {mode === "add"
            ? "It goes into your New queue, and every change to it is kept in its Activity."
            : "The change is saved straight away and recorded in the lead's Activity."}
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="field-label">Business name</span>
            <input
              ref={nameRef}
              type="text"
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="ui-field w-full"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="field-label">Phone</span>
            <input
              type="tel"
              required
              maxLength={40}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 415 555 0182"
              className="ui-field tnum w-full font-mono"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="field-label">Source</span>
            <select
              value={source}
              onChange={(event) => setSource(event.target.value as LeadSource)}
              className="ui-field w-full cursor-pointer"
            >
              {LEAD_SOURCES.map((option) => (
                <option key={option} value={option}>
                  {LEAD_SOURCE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="field-label">Source link</span>
            <input
              type="text"
              inputMode="url"
              maxLength={500}
              value={sourceLink}
              onChange={(event) => setSourceLink(event.target.value)}
              placeholder={`The ${LEAD_SOURCE_LABELS[source]} page you found it on`}
              className="ui-field w-full"
            />
          </label>

          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="field-label">Website</span>
            <input
              type="text"
              inputMode="url"
              maxLength={500}
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="example.com"
              className="ui-field w-full"
            />
          </label>

          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="field-label">Address</span>
            <input
              type="text"
              autoComplete="street-address"
              maxLength={300}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Street, city, state and postcode"
              className="ui-field w-full"
            />
          </label>
        </div>

        {mode === "add" && (
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="field-label">Lead status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as CallStatus)}
                className="ui-field w-full cursor-pointer"
              >
                {CALL_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {CALL_STATUS_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="field-label">Call notes</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                placeholder="What was said, who to ask for next time, what they asked about…"
                className="ui-field h-auto w-full resize-y p-2.5 leading-relaxed"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="field-label">Meeting date</span>
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="ui-field w-full"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="field-label">Meeting time</span>
              <input
                type="time"
                value={time}
                disabled={!date}
                onChange={(event) => setTime(event.target.value)}
                className="ui-field w-full disabled:opacity-60"
              />
            </label>

            {date && (
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="field-label">With</span>
                <input
                  type="text"
                  value={attendees}
                  onChange={(event) => setAttendees(event.target.value)}
                  placeholder="Who is joining, and in what capacity"
                  className="ui-field w-full"
                />
              </label>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-caption text-danger">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={saving || !name.trim() || !phone.trim()}
            className="ui-btn ui-btn-primary h-9"
          >
            {saving ? "Saving…" : mode === "add" ? "Add lead" : "Save details"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="ui-btn ui-btn-ghost h-9"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
