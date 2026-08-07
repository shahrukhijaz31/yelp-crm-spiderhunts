"use client";

import { useEffect, useRef, useState } from "react";

import CallbackCell from "./CallbackCell";
import NotesCell from "./NotesCell";
import StatusSelect from "./StatusSelect";
import WhatsAppLink from "./WhatsAppLink";
import { callbackState, displayWebsite, websiteHref } from "@/lib/leadUtils";
import type { Lead, LeadEditableFields } from "@/lib/types";

/** How long the green confirmation wash and the "Saved" chip stay up. */
const SAVED_FEEDBACK_MS = 1800;

/**
 * Typographic hierarchy, in order of what an agent needs before dialling:
 *   PRIMARY    business name (`text-cell`, semibold, full-contrast ink) and
 *              phone (`text-num`, mono, full-contrast ink)
 *   SECONDARY  address, website (`text-ui`, fg-2) then category (fg-3)
 *   TERTIARY   rating and owner (`text-meta`, quietest step that is still read)
 *
 * Four sizes across the row, not one: the gap between the name and everything
 * beside it is what lets an agent find a business by shape rather than by
 * reading each cell, and it is worth more than any absolute font size. The
 * sizes themselves are named steps from `globals.css`, so the whole table's
 * density is retuned there rather than cell by cell.
 *
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
  // are filtered out at ingest. It is drawn as an inset stripe down the first
  // cell — see `.lead-table-frozen td[data-urgency]` — rather than as a border
  // on the <tr>, since a positioned pseudo-element on a row gets laid out as
  // an anonymous cell and shunts the whole row across.
  const urgency = state === "overdue" || state === "today" ? state : undefined;

  // The scraper stores whatever Yelp displayed, usually a bare domain, which is
  // a relative path to a browser. Null means it is not a linkable address.
  const websiteUrl = lead.website ? websiteHref(lead.website) : null;

  const dirty = draft !== null;

  return (
    <tr
      // `focus-within` as well as `hover`: tabbing through the working columns
      // should light the row up the same way the cursor does, or a keyboard
      // user has no idea which lead they are about to change.
      className={`group border-b border-line align-middle transition-colors hover:bg-hover focus-within:bg-hover ${
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
      {/* pl-[19px] matches the header: 3px of stripe plus 16px of gutter. */}
      <td data-urgency={urgency} className="py-2.5 pl-[19px] pr-3">
        <span
          className="block truncate text-cell font-semibold tracking-[-0.006em] text-fg"
          title={lead.name}
        >
          {lead.name}
        </span>
        {/* Only drawn when there is something to say — an always-present empty
            line under every name would cost 16px a row across the whole list. */}
        {(lead.rating !== null || lead.owner) && (
          <div className="mt-0.5 flex items-center gap-2 text-meta text-fg-3">
            {lead.rating !== null && (
              <span className="tnum shrink-0 font-mono">
                {lead.rating.toFixed(1)}★
              </span>
            )}
            {lead.owner && (
              <span className="truncate" title={lead.owner}>
                {lead.owner}
              </span>
            )}
          </div>
        )}
      </td>

      {/* Always present: `cleanLeads` drops rows without a dialable number. */}
      <td className="whitespace-nowrap px-2.5 py-2.5">
        <span className="flex items-center gap-2">
          <span className="tnum font-mono text-num font-medium tracking-[-0.01em] text-fg">
            {lead.phone}
          </span>
          <WhatsAppLink phone={lead.phone} leadName={lead.name} />
        </span>
      </td>

      <td
        className="truncate px-3 py-2.5 text-ui text-fg-2"
        title={lead.address}
      >
        {lead.address || <Flag>No address</Flag>}
      </td>

      <td className="truncate px-3 py-2.5 text-ui text-fg-3">
        {lead.categories.length > 0 ? (
          <span title={lead.categories.join(", ")}>
            {lead.categories.slice(0, 2).join(", ")}
            {lead.categories.length > 2 && (
              <span className="text-fg-3"> +{lead.categories.length - 2}</span>
            )}
          </span>
        ) : (
          <span className="text-fg-3">—</span>
        )}
      </td>

      <td className="px-3 py-2.5">
        {!lead.website ? (
          <Flag>No website</Flag>
        ) : websiteUrl ? (
          <a
            href={websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={websiteUrl}
            className="block truncate rounded-sm text-ui text-fg-2 underline decoration-fg-4/40 underline-offset-[3px] transition-colors hover:text-fg hover:decoration-accent"
          >
            {displayWebsite(lead.website)}
          </a>
        ) : (
          // Scraped text that is not a usable address. Still shown — an agent
          // may recognise it — but not as a link that would go nowhere.
          <span title={lead.website} className="block truncate text-ui text-fg-3">
            {displayWebsite(lead.website)}
          </span>
        )}
      </td>

      {/* --- working columns: tinted panel behind the interactive cells ---
          All three are middle-aligned so the status chip, the callback date
          and the first line of a note sit on one optical line across the row,
          and the notes cell simply grows about its centre when a pending bar
          appears under it. */}
      <td className="border-l border-line bg-recessed px-2 py-2 align-middle group-hover:bg-hover group-focus-within:bg-hover">
        <StatusSelect
          value={shownStatus}
          pending={draft?.status !== undefined}
          onChange={(status) => stage({ status })}
        />
      </td>

      {/* Callback stays immediate — picking a date is already deliberate. */}
      <td className="bg-recessed px-2 py-2 align-middle group-hover:bg-hover group-focus-within:bg-hover">
        <CallbackCell
          lead={lead}
          today={today}
          onChange={(callbackDate) => onUpdate(lead.id, { callbackDate })}
        />
      </td>

      <td className="bg-recessed py-2 pl-2 pr-4 align-middle group-hover:bg-hover group-focus-within:bg-hover">
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
            className="mt-1.5 flex items-center gap-1.5 px-2 text-meta font-medium text-st-green"
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
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-meta font-medium text-st-gold"
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
          className="rounded px-2 py-1 text-caption font-medium text-fg-3 transition-colors hover:bg-line hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          aria-label={`Save changes to ${leadName}`}
          className="inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-caption font-medium text-on-accent transition-colors hover:bg-accent-2"
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
    <span className="inline-flex items-center gap-1.5 text-ui font-medium text-warn">
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

