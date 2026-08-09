"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, Star } from "lucide-react";

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
      {/* pl-[18px] matches the header: 2px of urgency stripe plus 16px. */}
      <td data-urgency={urgency} className="py-2 pl-[18px] pr-3">
        {/* The strongest text in the table, and the only `cell` step used in a
            row. Medium rather than semibold: at 15px on a 14px page, weight
            *and* size together makes the name shout, and one of the two is
            enough to make it the thing the eye lands on. */}
        <span
          className="block truncate text-cell font-medium tracking-[-0.012em] text-fg"
          title={lead.name}
        >
          {lead.name}
        </span>
        {/* Only drawn when there is something to say — an always-present empty
            line under every name would cost 16px a row across the whole list. */}
        {(lead.rating !== null || lead.owner) && (
          <div className="mt-0.5 flex items-center gap-1.5 text-meta text-fg-4">
            {lead.rating !== null && (
              <span className="tnum flex shrink-0 items-center gap-0.5 font-mono">
                <Star className="h-2.5 w-2.5 fill-current" strokeWidth={0} aria-hidden="true" />
                {lead.rating.toFixed(1)}
              </span>
            )}
            {lead.rating !== null && lead.owner && (
              <span aria-hidden="true">·</span>
            )}
            {lead.owner && (
              <span className="truncate" title={lead.owner}>
                {lead.owner}
              </span>
            )}
          </div>
        )}
      </td>

      {/* Always present: `cleanLeads` drops rows without a dialable number.
          The number is set in the mono face at full contrast — after the
          business name it is the single most-read thing in the row, because it
          is the thing an agent is about to dial. */}
      <td className="whitespace-nowrap px-3 py-2">
        <span className="flex items-center gap-1.5">
          <span className="tnum font-mono text-num tracking-[-0.02em] text-fg">
            {lead.phone}
          </span>
          <WhatsAppLink phone={lead.phone} leadName={lead.name} />
        </span>
      </td>

      <td
        className="truncate px-3 py-2 text-ui text-fg-2"
        title={lead.address}
      >
        {lead.address || <Flag>No address</Flag>}
      </td>

      <td className="truncate px-3 py-2 text-ui text-fg-3">
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
        {!lead.website ? (
          <Flag>No website</Flag>
        ) : websiteUrl ? (
          // An external link, and marked as one. The arrow appears on hover
          // rather than always: a glyph on every row of a column is chrome,
          // and the underline already says "link".
          <a
            href={websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={websiteUrl}
            className="group/link inline-flex max-w-full items-center gap-1 rounded-sm text-ui text-fg-2 transition-colors hover:text-fg"
          >
            <span className="truncate underline decoration-line-2 underline-offset-[3px] transition-colors group-hover/link:decoration-fg-4">
              {displayWebsite(lead.website)}
            </span>
            <ArrowUpRight
              className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100"
              strokeWidth={2}
              aria-hidden="true"
            />
          </a>
        ) : (
          // Scraped text that is not a usable address. Still shown — an agent
          // may recognise it — but not as a link that would go nowhere.
          <span title={lead.website} className="block truncate text-ui text-fg-3">
            {displayWebsite(lead.website)}
          </span>
        )}
      </td>

      {/* --- working columns -----------------------------------------------
          The three an agent edits. They used to sit on a tinted `recessed`
          panel; that tint is gone. A block of differently-coloured cells
          running down a table is the loudest "admin template" signal there is,
          and the one vertical hairline before Status says the same thing —
          scraper on the left, agent on the right — without repainting a third
          of every row.

          All three are middle-aligned so the status pill, the callback date
          and the first line of a note sit on one optical line across the row,
          and the notes cell grows about its centre when a pending bar appears
          under it. */}
      <td className="border-l border-line px-2 py-2 align-middle">
        <StatusSelect
          value={shownStatus}
          pending={draft?.status !== undefined}
          onChange={(status) => stage({ status })}
        />
      </td>

      {/* Booking stays immediate — it happens behind an explicit Book button in
          a dialog, which is already the deliberate confirmation that the staged
          Save/Cancel bar provides for the dropdown and the notes box. */}
      <td className="px-2 py-2 align-middle">
        <CallbackCell
          lead={lead}
          today={today}
          onChange={(changes) => onUpdate(lead.id, changes)}
        />
      </td>

      <td className="py-2 pl-2 pr-4 align-middle">
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
            className="mt-1.5 flex items-center gap-1.5 px-2 text-meta font-medium text-success"
          >
            <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />
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
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-meta font-medium text-warning"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
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
          className="rounded-md px-2 py-1 text-caption font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          aria-label={`Save changes to ${leadName}`}
          className="inline-flex items-center gap-1 rounded-md bg-accent-solid px-2 py-1 text-caption font-medium text-on-accent transition-colors hover:brightness-110"
        >
          <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Visual language: **an annotation, not a chip.**
 *
 * "No website" is a gap in the scraped data, not an alarm — so it gets no
 * fill, no border and no red. A small outline triangle and muted text with a
 * dashed underline: something pencilled in the margin where a value should
 * have been. A filled warning pill here would give an absent field the same
 * weight as a deliberate "Do not call", which is a lie about its importance,
 * and a column of them would turn the table into a hazard sign.
 */
function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ui text-fg-3">
      <AlertTriangle
        className="h-3.5 w-3.5 shrink-0 text-warning"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="flag-underline decoration-line-2">{children}</span>
    </span>
  );
}

