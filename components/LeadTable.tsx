"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, SearchX } from "lucide-react";

import LeadRow from "./LeadRow";
import type { LeadSort, LeadSortKey } from "@/lib/leadQuery";
import type { Lead } from "@/lib/types";

/**
 * Fixed column widths. With `table-fixed` every row is exactly one line tall,
 * so the list keeps a steady vertical rhythm instead of jumping around as
 * business names and addresses wrap — which is what makes 30 rows scannable.
 *
 * **Three columns left this table.** Status, Callback/meeting and Notes were
 * editing surfaces — a dropdown, a booking dialog, a textarea and a Save bar,
 * inside a row twenty of which are on screen at once. They now live on the
 * lead's own page, where there is room to work one lead properly, and this
 * screen went back to the question it is actually good at: *which* lead next.
 *
 * Status and the booked date remain as read-only chips, because a queue of
 * already-called leads with no outcome beside them would have to be opened one
 * row at a time to be understood. Notes did not: a note is written to be read
 * in full, and two truncated lines in a 13% column was never that.
 *
 * The table is ~300px narrower as a result, which is the difference between
 * scrolling sideways on a laptop and not.
 *
 * There are no row checkboxes here. Choosing rows is part of exporting, and
 * exporting lives entirely in the Export view — this screen is for working the
 * call list.
 */
const COLUMNS: Array<{
  label: string;
  width: string;
  /** Present on the four scraped columns a header click can order by. */
  sortKey?: LeadSortKey;
}> = [
  // Widest of the columns, and frozen against horizontal scroll: the business
  // name is what an agent is scanning for *and* the link into the lead's
  // workspace, so it gets both the room for a longer name before truncation
  // and a permanent seat on screen.
  { label: "Business", width: "24%", sortKey: "name" },
  // Wider than the number needs: it also carries the WhatsApp glyph, and the
  // cell never wraps, so a tight column would clip one or the other.
  { label: "Phone", width: "13%", sortKey: "phone" },
  { label: "Address", width: "19%", sortKey: "address" },
  // Truncates by design and carries the full value in a title tooltip.
  { label: "Category", width: "11%", sortKey: "category" },
  { label: "Website", width: "14%" },
  // Sized against their longest content: "Not interested" as a chip, and a
  // date with a time beside it.
  { label: "Status", width: "11%" },
  { label: "Booked", width: "8%" },
];

/**
 * One page of the list, rendered in full — no virtualisation.
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
  hrefFor,
  onOpen,
  datasetKey,
}: {
  leads: Lead[];
  today: string;
  sort: LeadSort;
  onSort: (key: LeadSortKey) => void;
  /**
   * Where a row points. Supplied by `Worklist` rather than built here, because
   * the address carries the queue, tab, filters and sort the row was found
   * under — and this component is handed rows, not the query behind them.
   */
  hrefFor: (lead: Lead, index: number) => string;
  /**
   * Open a row as a window over this list. The index is what the workspace
   * walks with — Previous and Next are positions in the page of rows this
   * table was handed, not a second query.
   */
  onOpen: (index: number) => void;
  /**
   * Identifies *which* set of rows is on screen — the page, tab, sort and
   * filters. Changing it fades the new rows in.
   */
  datasetKey: string;
}) {
  return (
    // No panel of its own: the table is the body of the workspace surface,
    // between the toolbar strip above it and the pager strip below. Only the
    // rows scroll — the toolbar and the pager stay put, which is what makes a
    // long list feel like a window onto data rather than a long page.
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="lead-table lead-table-frozen w-full min-w-[1120px] table-fixed border-collapse">
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
                // The header is one continuous `rail` strip — see
                // `.lead-table thead th` in `globals.css`, where the fill and
                // the rule under it are set, the latter as a shadow because a
                // sticky `border-collapse` cell drops its borders in several
                // browsers.
                //
                // The working columns are no longer tinted. A block of
                // differently-coloured cells running down a table is the
                // clearest "admin template" tell there is, and it was doing a
                // job that one vertical hairline before Status does more
                // quietly: separating what the scraper knows from what the
                // agent decides.
                className={`col-head py-2.5 text-left ${
                  index === 0 ? "pl-[18px] pr-3" : "px-3"
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
        {/*
         * `key` on the tbody, not on the rows.
         *
         * When the page, tab, sort or filters change, this key changes with
         * them, React throws the whole body away and the replacement fades in
         * — one 160ms transition for the new set of rows. Keying the rows
         * individually instead would animate every row that happened to move,
         * which on a sort is all of them, and on an inline edit would flash
         * the row an agent just saved.
         *
         * Deliberately not tied to `leads` itself: editing a status in place
         * produces a new array, and that must not re-animate the table
         * underneath the person who just clicked it.
         */}
        <tbody key={datasetKey} className="table-body-enter">
          {leads.map((lead, index) => (
            <LeadRow
              key={lead.id}
              lead={lead}
              today={today}
              href={hrefFor(lead, index)}
              onOpen={() => onOpen(index)}
            />
          ))}
          {leads.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="px-5 py-20 text-center">
                {/* An empty table is the one place this app has room for a
                    figure. It is drawn from the same hairline and fg-4 the
                    rest of the chrome uses, so it reads as the table's own
                    empty state rather than as an illustration dropped in. */}
                <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-recessed text-fg-4">
                  <SearchX className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                </span>
                <p className="text-cell font-medium text-fg">No leads here</p>
                <p className="mx-auto mt-1.5 max-w-[40ch] text-ui leading-relaxed text-fg-3">
                  Nothing matches the current view. Try clearing a filter, or
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
  const className = `ml-auto h-3 w-3 shrink-0 transition-opacity ${
    active
      ? "opacity-100 text-fg-2"
      : "opacity-0 group-hover:opacity-40 group-focus-visible:opacity-40"
  }`;

  if (!active) {
    return <ChevronsUpDown className={className} strokeWidth={2} aria-hidden="true" />;
  }

  return direction === "asc" ? (
    <ArrowUp className={className} strokeWidth={2} aria-hidden="true" />
  ) : (
    <ArrowDown className={className} strokeWidth={2} aria-hidden="true" />
  );
}
