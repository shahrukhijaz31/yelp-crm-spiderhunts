"use client";

import { useEffect, useRef, useState } from "react";

import CallbackCell from "./CallbackCell";
import NotesCell from "./NotesCell";
import StatusSelect from "./StatusSelect";
import WhatsAppLink from "./WhatsAppLink";
import { callbackState, displayWebsite } from "@/lib/leadUtils";
import type { Lead, LeadEditableFields } from "@/lib/types";

/** How long the green confirmation wash and the "Saved" chip stay up. */
const SAVED_FEEDBACK_MS = 1800;

/**
 * Typographic hierarchy, in order of what an agent needs before dialling:
 *   PRIMARY    business name (14px semibold ink) and phone (14px mono ink)
 *   SECONDARY  address, category, website (12.5px, muted)
 *   TERTIARY   rating and owner (11px, quietest)
 * The working columns — status, callback, notes — are set apart by living on a
 * faintly tinted panel to the right of a hairline.
 *
 * Status and notes are *staged*, not committed: editing them fills a local
 * draft and the row grows a Save/Cancel bar. Nothing reaches the central lead
 * state until Save, so a mis-click on a dropdown mid-call costs nothing.
 * The callback date is deliberately still immediate — picking a date from a
 * calendar is already a deliberate, hard-to-fat-finger action.
 */
export default function LeadRow({
  lead,
  today,
  onUpdate,
}: {
  lead: Lead;
  today: string;
  onUpdate: (id: string, changes: Partial<LeadEditableFields>) => void;
}) {
  /** Pending edits. `null` means the row is clean. */
  const [draft, setDraft] = useState<Partial<LeadEditableFields> | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  // What the row displays: the draft where one exists, the lead otherwise.
  const shownStatus = draft?.status ?? lead.status;
  const shownNotes = draft?.notes ?? lead.notes;
  const state = callbackState(lead, today);

  /**
   * Stage a change, dropping any field that matches what is already committed —
   * so setting a dropdown back to its original value clears the pending state
   * instead of leaving a no-op edit to save.
   */
  function stage(changes: Partial<LeadEditableFields>) {
    setJustSaved(false);
    setDraft((current) => {
      const merged = { ...current, ...changes };
      const next: Partial<LeadEditableFields> = {};
      if (merged.status !== undefined && merged.status !== lead.status) {
        next.status = merged.status;
      }
      if (merged.notes !== undefined && merged.notes !== lead.notes) {
        next.notes = merged.notes;
      }
      return Object.keys(next).length > 0 ? next : null;
    });
  }

  function save() {
    if (!draft) return;
    onUpdate(lead.id, draft);
    setDraft(null);
    setJustSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setJustSaved(false), SAVED_FEEDBACK_MS);
  }

  function cancel() {
    setDraft(null);
  }

  // Callback urgency is the only row-level marker now that unreachable leads
  // are filtered out at ingest. The marker is a left border on the first cell —
  // a positioned pseudo-element on a <tr> gets laid out as an anonymous cell
  // and shunts the whole row across.
  const accent =
    state === "overdue"
      ? "border-l-accent/40"
      : state === "today"
        ? "border-l-accent"
        : "border-l-transparent";

  const dirty = draft !== null;

  return (
    <tr
      className={`group border-b border-line/70 align-middle transition-colors hover:bg-hover ${
        justSaved ? "row-saved" : ""
      }`}
      // Escape anywhere in the row abandons the pending edit.
      onKeyDown={(event) => {
        if (event.key === "Escape" && dirty) {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <td className={`border-l-[3px] py-2 pl-4 pr-3 ${accent}`}>
        <span
          className="block truncate text-[14px] font-semibold leading-tight tracking-[-0.005em] text-fg"
          title={lead.name}
        >
          {lead.name}
        </span>
        <div className="mt-px flex items-center gap-2 text-[10.5px] leading-tight text-fg-4">
          {lead.rating !== null && (
            <span className="tnum font-mono">{lead.rating.toFixed(1)}★</span>
          )}
          {lead.owner && <span className="truncate">{lead.owner}</span>}
        </div>
      </td>

      {/* Always present: `cleanLeads` drops rows without a dialable number. */}
      <td className="whitespace-nowrap px-3 py-2">
        <span className="flex items-center gap-1.5">
          <span className="tnum font-mono text-[13.5px] font-medium text-fg">
            {lead.phone}
          </span>
          <WhatsAppLink phone={lead.phone} leadName={lead.name} />
        </span>
      </td>

      <td
        className="truncate px-3 py-2 text-[12.5px] text-fg-2"
        title={lead.address}
      >
        {lead.address || <Flag>No address</Flag>}
      </td>

      <td className="truncate px-3 py-2 text-[12.5px] text-fg-3">
        {lead.categories.length > 0 ? (
          <span title={lead.categories.join(", ")}>
            {lead.categories.slice(0, 2).join(", ")}
            {lead.categories.length > 2 && (
              <span className="text-fg-4"> +{lead.categories.length - 2}</span>
            )}
          </span>
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </td>

      <td className="px-3 py-2">
        {lead.website ? (
          <a
            href={lead.website}
            target="_blank"
            rel="noopener noreferrer"
            title={lead.website}
            className="block truncate text-[12.5px] text-fg-2 underline decoration-fg-4/40 underline-offset-2 transition-colors hover:text-fg hover:decoration-fg-2"
          >
            {displayWebsite(lead.website)}
          </a>
        ) : (
          <Flag>No website</Flag>
        )}
      </td>

      {/* --- working columns: tinted panel behind the interactive cells --- */}
      <td className="border-l border-line bg-recessed px-3 py-2 align-top group-hover:bg-hover">
        <StatusSelect
          value={shownStatus}
          pending={draft?.status !== undefined}
          onChange={(status) => stage({ status })}
        />
      </td>

      {/* Callback stays immediate — picking a date is already deliberate. */}
      <td className="bg-recessed px-2 py-2 align-top group-hover:bg-hover">
        <CallbackCell
          lead={lead}
          today={today}
          onChange={(callbackDate) => onUpdate(lead.id, { callbackDate })}
        />
      </td>

      <td className="bg-recessed py-1.5 pl-2 pr-4 align-top group-hover:bg-hover">
        <NotesCell
          value={shownNotes}
          leadName={lead.name}
          pending={draft?.notes !== undefined}
          onChange={(notes) => stage({ notes })}
        />

        {dirty && (
          <PendingBar
            leadName={lead.name}
            fields={[
              ...(draft?.status !== undefined ? ["Status"] : []),
              ...(draft?.notes !== undefined ? ["Notes"] : []),
            ]}
            onSave={save}
            onCancel={cancel}
          />
        )}

        {justSaved && (
          <p
            role="status"
            className="mt-1.5 flex items-center gap-1.5 px-2 text-[11px] font-medium text-st-green"
          >
            <CheckIcon />
            Saved
          </p>
        )}
      </td>
    </tr>
  );
}

/**
 * The confirmation bar. It only exists while a row has staged changes, names
 * which fields are pending so an agent knows what they are committing, and
 * puts Save under the cursor that just made the edit.
 */
function PendingBar({
  leadName,
  fields,
  onSave,
  onCancel,
}: {
  leadName: string;
  fields: string[];
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2 px-2">
      {/* Compact on purpose — the notes column is narrow, so the field names
          live in the tooltip rather than wrapping the bar onto two lines. */}
      <span
        title={`Unsaved changes: ${fields.join(", ").toLowerCase()}`}
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-st-gold"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-st-gold"
        />
        <span aria-hidden="true">Unsaved</span>
        {/* Screen readers get the full sentence; the eye gets one short word. */}
        <span className="sr-only">
          Unsaved changes to {fields.join(" and ").toLowerCase()}
        </span>
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Discard changes to ${leadName}`}
          className="rounded px-1.5 py-1 text-[11.5px] text-fg-3 transition-colors hover:bg-line hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          aria-label={`Save changes to ${leadName}`}
          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-2"
        >
          <CheckIcon />
          Save
        </button>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path
        d="M2.5 6.3 4.8 8.6 9.5 3.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Visual language: **an annotation, not a chip.** No fill, no ring — rust text
 * with a dashed underline and a warning glyph, so it reads like something
 * pencilled in the margin rather than another coloured pill.
 */
function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-warn">
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden="true">
        <path
          d="M6 1.6 11.2 10.6H0.8z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <path d="M6 5.1v2.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="6" cy="9" r="0.55" fill="currentColor" />
      </svg>
      <span className="flag-underline decoration-warn/50">{children}</span>
    </span>
  );
}

