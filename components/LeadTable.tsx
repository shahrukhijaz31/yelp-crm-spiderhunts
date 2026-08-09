"use client";

import LeadRow from "./LeadRow";
import type { Lead, LeadEditableFields } from "@/lib/types";

/**
 * Fixed column widths. With `table-fixed` every row is exactly one line tall,
 * so the list keeps a steady vertical rhythm instead of jumping around as
 * business names and addresses wrap — which is what makes 30 rows scannable.
 *
 * `working` columns are the ones an agent edits; they sit on a tinted panel.
 *
 * There are no row checkboxes here. Choosing rows is part of exporting, and
 * exporting lives entirely in the Export view — this screen is for working the
 * call list.
 */
const COLUMNS: Array<{ label: string; width: string; working?: boolean }> = [
  // Widest of the scraped columns, and frozen against horizontal scroll: the
  // business name is what an agent is scanning for, so it gets both the room
  // for a longer name before truncation and a permanent seat on screen.
  { label: "Business", width: "18%" },
  // Wider than the number needs: it also carries the WhatsApp glyph, and the
  // cell never wraps, so a tight column would clip one or the other.
  { label: "Phone", width: "12%" },
  { label: "Address", width: "13.5%" },
  // The two lowest-priority columns, trimmed to pay for the ones either side.
  // Both truncate by design and carry the full value in a title tooltip.
  { label: "Category", width: "8.5%" },
  { label: "Website", width: "10.5%" },
  // Sized against their *longest* content at the new type size, not their
  // average: "Not interested" and an overdue date with its clear button are
  // what these columns have to hold without clipping.
  { label: "Status", width: "12%", working: true },
  // "Callback" alone undersold it: this column is also how a meeting gets
  // booked, and how the Meetings agenda is populated. A wider column pays for
  // the time now shown beside the date.
  { label: "Callback / meeting", width: "12%", working: true },
  { label: "Notes", width: "13.5%", working: true },
];

/**
 * One page of the list, rendered in full — no virtualisation, no detail pages.
 *
 * Nothing here narrows or slices: `leads` is exactly what gets drawn. Which
 * leads those are is decided by Postgres and handed down by `Worklist`, so the
 * table cannot quietly disagree with the pager beneath it about how many rows
 * there are.
 */
export default function LeadTable({
  leads,
  today,
  onUpdate,
}: {
  leads: Lead[];
  today: string;
  onUpdate: (id: string, changes: Partial<LeadEditableFields>) => void;
}) {
  return (
    <div className="panel flex-1 overflow-auto">
      <table className="lead-table lead-table-frozen w-full min-w-[1460px] table-fixed border-collapse">
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.label} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {COLUMNS.map((column, index) => (
              <th
                key={column.label}
                scope="col"
                className={`col-head py-3.5 text-left ${
                  index === 0 ? "pl-[19px] pr-3" : "px-3"
                } ${
                  // The editable columns are announced as a group: their
                  // headings sit on the same tinted panel as the controls
                  // below them, one shade up from the scraped columns. The
                  // gradient fill and the rule under the whole header row come
                  // from `.lead-table thead th` — see `globals.css`, where they
                  // are drawn as a shadow because a sticky `border-collapse`
                  // cell drops its borders in several browsers.
                  column.working ? "is-working text-fg-2" : "bg-surface"
                } ${column.label === "Status" ? "border-l border-line" : ""}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <LeadRow
              key={lead.id}
              lead={lead}
              today={today}
              onUpdate={onUpdate}
            />
          ))}
          {leads.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="px-5 py-20 text-center">
                {/* An empty table is the one place this app has room for a
                    figure. It is drawn from the same hairline and fg-4 the
                    rest of the chrome uses, so it reads as the table's own
                    empty state rather than as an illustration dropped in. */}
                <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-recessed text-fg-4 shadow-e1">
                  <EmptyIcon />
                </span>
                <p className="display-num text-[22px] text-fg-2">Nothing here</p>
                <p className="mx-auto mt-2 max-w-[38ch] text-ui leading-relaxed text-fg-3">
                  No leads match the current view. Try clearing a filter, or
                  widening the search.
                </p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EmptyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6">
      <rect
        x="3.2"
        y="4.2"
        width="17.6"
        height="15.6"
        rx="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.2 9.2h17.6M9 9.2v10.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
