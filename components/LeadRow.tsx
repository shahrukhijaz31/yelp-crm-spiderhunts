"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Star } from "lucide-react";

import RowRecordingButton from "./RowRecordingButton";
import { StatusChip } from "./StatusSelect";
import WhatsAppLink from "./WhatsAppLink";
import {
  callbackState,
  displayWebsite,
  formatCallbackDate,
  websiteHref,
} from "@/lib/leadUtils";
import { formatMeetingTime, isMeetingLead } from "@/lib/meetings";
import type { RecordingSummary } from "@/lib/recordingRules";
import type { Lead } from "@/lib/types";

/**
 * One lead on the worklist — and, since the workspace exists, **one link**.
 *
 * This row used to be an editing surface: a status dropdown, a booking cell, a
 * notes box and a Save/Cancel bar that appeared under whichever of them had
 * been touched. All four moved to the lead's own page. What is left is the job
 * the list is actually good at — deciding *which* lead to work — so the row is
 * now read-only and every cell in it exists to answer that question:
 *
 *   PRIMARY    business name (`text-cell`, medium, full-contrast ink) and
 *              phone (`text-num`, mono, full-contrast ink)
 *   SECONDARY  address, website (`text-ui`, fg-2) then category (fg-3)
 *   TERTIARY   rating and owner (`text-meta`, quietest step still read)
 *
 * Status and the booked date stay, as **chips rather than controls**. Dropping
 * them entirely would have made the Called queue unreadable — a list of leads
 * with no outcome beside them is a list you have to open one by one to sort
 * out — and a chip is not an editing surface, which is the thing that moved.
 *
 * **The whole row is one link, and it is a real one.** A single
 * `<a href="/leads/…">` is stretched across the row by an absolutely-positioned
 * overlay. A plain click is intercepted and opens the lead as a window over
 * this list — the fast path, and the reason the list keeps its place — while
 * Ctrl/Cmd-click, middle-click and "Open in new tab" are left to the browser
 * and follow the href to the lead's own address. Both behaviours come out of
 * one anchor, which is why this is not a div with a handler.
 *
 * The stacking is the whole trick, and it is worth stating because it is not
 * obvious from the markup:
 *
 *   the overlay        z-6, anchored to the `<tr>`
 *   the frozen cell    z-5 (it is `position: sticky`, see globals.css)
 *   the real links     z-7 — phone, WhatsApp, website
 *
 * The overlay has to clear the frozen business cell or the business name would
 * be the one part of the row that is not clickable. The links have to clear the
 * overlay, or clicking a website would open the lead instead of the website.
 * Both are one number, and both are load-bearing.
 *
 * The overlay is also the only link in the row that points at the lead — the
 * name is plain text. Two anchors to the same place would be read out twice by
 * a screen reader and would make Tab stop on the row twice.
 */
export default function LeadRow({
  lead,
  today,
  href,
  onOpen,
  recording,
  onRecordingSaved,
}: {
  lead: Lead;
  today: string;
  /** The lead's workspace, carrying the list it was opened from. */
  href: string;
  /** Open the lead over this list, without leaving it. */
  onOpen: () => void;
  /**
   * The call recording on this lead, if there is one this agent may see.
   * Read-only here — the row shows that audio exists and offers to add or
   * replace it; playing, and deleting, stay in the workspace.
   */
  recording: RecordingSummary | null;
  /** A finished quick upload, written back into this row alone. */
  onRecordingSaved: (recording: RecordingSummary) => void;
}) {
  const state = callbackState(lead, today);

  // Callback urgency is the only row-level marker now that unreachable leads
  // are filtered out at ingest. It is drawn as an inset stripe down the first
  // cell — see `.lead-table-frozen td[data-urgency]` — rather than as a border
  // on the <tr>, since a positioned pseudo-element on a row gets laid out as
  // an anonymous cell and shunts the whole row across.
  const urgency = state === "overdue" || state === "today" ? state : undefined;

  // The scraper stores whatever Yelp displayed, usually a bare domain, which is
  // a relative path to a browser. Null means it is not a linkable address.
  const websiteUrl = lead.website ? websiteHref(lead.website) : null;

  return (
    <tr
      // `relative` is what the row-wide link overlay is measured against.
      //
      // The row's background — base, alternating and hover — is set in
      // `globals.css` rather than here. It has to be: the frozen first cell
      // paints its own opaque background, so a `hover:bg-hover` utility on the
      // row would light every column except the one with the business name in
      // it. The stylesheet names the row and that cell together.
      className="group relative border-b border-line align-middle"
    >
      {/* pl-[18px] matches the header: 2px of urgency stripe plus 16px. */}
      <td data-urgency={urgency} className="py-2 pl-[18px] pr-3">
        {/* The strongest text in the table, and the only `cell` step used in a
            row. Medium rather than semibold: at 15px on a 14px page, weight
            *and* size together makes the name shout, and one of the two is
            enough to make it the thing the eye lands on. */}
        <span className="row-open-name block truncate text-cell font-medium tracking-[-0.012em] text-fg">
          {lead.name}
        </span>
        {/* Only drawn when there is something to say — an always-present empty
            line under every name would cost 16px a row across the whole list. */}
        {(lead.rating !== null || lead.owner) && (
          <span className="mt-0.5 flex items-center gap-1.5 text-meta text-fg-3">
            {lead.rating !== null && (
              <span className="tnum flex shrink-0 items-center gap-0.5 font-mono">
                <Star className="h-2.5 w-2.5 fill-current" strokeWidth={0} aria-hidden="true" />
                {lead.rating.toFixed(1)}
              </span>
            )}
            {lead.rating !== null && lead.owner && <span aria-hidden="true">·</span>}
            {lead.owner && (
              <span className="truncate" title={lead.owner}>
                {lead.owner}
              </span>
            )}
          </span>
        )}
      </td>

      {/* Always present: `cleanLeads` drops rows without a dialable number.
          The number is set in the mono face at full contrast — after the
          business name it is the single most-read thing in the row, because it
          is the thing an agent is about to dial.

          The WhatsApp glyph is lifted above the row overlay so that clicking it
          opens a chat rather than the lead. */}
      <td className="whitespace-nowrap px-3 py-2">
        <span className="flex items-center gap-1.5">
          <span className="tnum font-mono text-num tracking-[-0.02em] text-fg">
            {lead.phone}
          </span>
          <span className="row-inner-link flex">
            <WhatsAppLink phone={lead.phone} leadName={lead.name} />
          </span>
        </span>
      </td>

      <td className="truncate px-3 py-2 text-ui text-fg-2" title={lead.address}>
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
          //
          // `row-inner-link` lifts it above the row's own overlay — without it
          // this cell would open the lead workspace, which is the one thing a
          // link labelled with a domain must not do.
          <a
            href={websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={websiteUrl}
            className="row-inner-link group/link inline-flex max-w-full items-center gap-1 rounded-sm text-ui text-fg-2 transition-colors hover:text-fg"
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

      {/* --- what the agent already decided ---------------------------------
          Both read-only, and to the right of one vertical hairline: scraped
          facts on the left, the workspace's answer on the right. Editing them
          is what the lead's own page is for. */}
      <td className="border-l border-line px-3 py-2">
        <StatusChip status={lead.status} />
      </td>

      {/* The one action left in a read-only row, and it is deliberately the
          smallest thing in it: a 28px glyph that opens a file picker and posts
          to the same endpoint the workspace does. Nothing else about the row
          became editable — this is a shortcut for an agent who already knows
          which file belongs to which call. See `RowRecordingButton` for why an
          ineligible lead shows nothing at all. */}
      {/* `relative` so a failed upload's message can be floated out of a cell
          only wide enough for the control itself. */}
      <td className="relative px-3 py-2">
        <RowRecordingButton
          leadId={lead.id}
          leadName={lead.name}
          recording={recording}
          // Judged on the *saved* lead, the same way the workspace judges it:
          // the upload posts immediately and the server reads the row.
          eligible={isMeetingLead(lead)}
          onSaved={onRecordingSaved}
        />
      </td>

      <td className="whitespace-nowrap px-3 py-2">
        {/*
         * The row's link.
         *
         * It lives in the last cell rather than the first, and that is not
         * arbitrary: the business cell is `position: sticky` (it is frozen
         * against horizontal scroll), so an overlay inside it is measured
         * against *that cell* and can never reach the rest of the row. A
         * non-positioned cell lets the overlay anchor to the `<tr>` instead.
         *
         * Its label is the whole of what this link is for, because there is no
         * visible text inside it — the row is what you see, and this is what
         * you click.
         */}
        <Link
          href={href}
          onClick={(event) => {
            // A plain click opens the workspace *over* this list, so the page,
            // the search, the filters and the scroll position an agent built up
            // are still there when they close it. Nothing here reimplements the
            // browser: a Ctrl/Cmd/Shift click, a middle click or "open in new
            // tab" is left alone and follows the href to the lead's own
            // address, which is why this is still a real link with a real
            // target rather than a div with a handler.
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            onOpen();
          }}
          title={`${lead.name} — open workspace`}
          aria-label={`Open ${lead.name}`}
          className="row-open-link"
        />

        {lead.callbackDate ? (
          <span
            className={`tnum font-mono text-caption font-medium ${
              state === "overdue"
                ? "text-accent"
                : state === "today"
                  ? "text-accent"
                  : "text-fg-2"
            }`}
          >
            {formatCallbackDate(lead.callbackDate, today)}
            {lead.meetingTime && (
              <span className="text-fg-3"> {formatMeetingTime(lead.meetingTime)}</span>
            )}
          </span>
        ) : (
          <span className="text-fg-4">—</span>
        )}
      </td>
    </tr>
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
