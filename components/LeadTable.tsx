"use client";

import LeadRow from "./LeadRow";
import type { LeadSort, LeadSortKey } from "@/lib/leadQuery";
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
const COLUMNS: Array<{
  label: string;
  width: string;
  working?: boolean;
  /** Present on the four scraped columns a header click can order by. */
  sortKey?: LeadSortKey;
}> = [
  // Widest of the scraped columns, and frozen against horizontal scroll: the
  // business name is what an agent is scanning for, so it gets both the room
  // for a longer name before truncation and a permanent seat on screen.
  { label: "Business", width: "18%", sortKey: "name" },
  // Wider than the number needs: it also carries the WhatsApp glyph, and the
  // cell never wraps, so a tight column would clip one or the other.
  { label: "Phone", width: "12%", sortKey: "phone" },
  { label: "Address", width: "13.5%", sortKey: "address" },
  // The two lowest-priority columns, trimmed to pay for the ones either side.
  // Both truncate by design and carry the full value in a title tooltip.
  { label: "Category", width: "8.5%", sortKey: "category" },
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
  sort,
  onSort,
  onUpdate,
}: {
  leads: Lead[];
  today: string;
  sort: LeadSort;
  onSort: (key: LeadSortKey) => void;
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
            {COLUMNS.map((column, index) => {
              const active = column.sortKey !== undefined && sort.key === column.sortKey;
              return (
              <th
                key={column.label}
                scope="col"
                // `aria-sort` is what tells a screen reader the table is
                // ordered and by which column — the arrow beside the label
                // says it to everyone else, and neither substitutes for the
                // other. Only ever set on the column actually in force.
                aria-sort={
                  active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                }
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
                {column.sortKey ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.sortKey!)}
                    // Inherits `.col-head` from the cell rather than restating
                    // it, so a sortable heading and a plain one are the same
                    // type at the same weight — the arrow is the only thing
                    // that marks one out, and only once it is in use.
                    className={`group -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:text-fg-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                      active ? "text-fg-2" : ""
                    }`}
                  >
                    <span className="truncate">{column.label}</span>
                    <SortArrow active={active} direction={sort.direction} />
                  </button>
                ) : (
                  column.label
                )}
              </th>
              );
            })}
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

/**
 * The sort indicator: a single arrow on the column in force, and a dimmed
 * double chevron on the others that only appears under the cursor.
 *
 * Showing the hint on hover rather than always is what keeps eight headings
 * from turning into eight pieces of chrome — the header's job is to name the
 * columns, and only one of them is ever actually sorted. It still occupies its
 * space when hidden (`opacity-0`, not `hidden`), so a heading does not shift
 * sideways as the pointer crosses it.
 */
function SortArrow({ active, direction }: { active: boolean; direction: "asc" | "desc" }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`ml-auto h-3 w-3 shrink-0 transition-opacity ${
        active ? "opacity-100" : "opacity-0 group-hover:opacity-45 group-focus-visible:opacity-45"
      }`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {active ? (
        direction === "asc" ? (
          <path d="M6 9.5V2.5M3 5.5 6 2.5l3 3" />
        ) : (
          <path d="M6 2.5v7M3 6.5 6 9.5l3-3" />
        )
      ) : (
        <path d="M3.25 4.75 6 2 8.75 4.75M3.25 7.25 6 10l2.75-2.75" />
      )}
    </svg>
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
