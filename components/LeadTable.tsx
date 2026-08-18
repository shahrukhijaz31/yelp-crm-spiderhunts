"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, SearchX } from "lucide-react";

import LeadRow from "./LeadRow";
import type { DemoSummaryMap } from "@/lib/demoWebsiteRules";
import type { LeadSection, LeadSort, LeadSortKey } from "@/lib/leadQuery";
import type { DemoSummary } from "@/lib/demoWebsiteRules";
import type { RecordingSummary } from "@/lib/recordingRules";
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
interface Column {
  label: string;
  width: string;
  /** Present on the four scraped columns a header click can order by. */
  sortKey?: LeadSortKey;
}

const COLUMNS: Column[] = [
  // Widest of the columns, and frozen against horizontal scroll: the business
  // name is what an agent is scanning for *and* the link into the lead's
  // workspace, so it gets both the room for a longer name before truncation
  // and a permanent seat on screen.
  { label: "Business", width: "23%", sortKey: "name" },
  // Wider than the number needs: it also carries the WhatsApp glyph, and the
  // cell never wraps, so a tight column would clip one or the other.
  { label: "Phone", width: "13%", sortKey: "phone" },
  { label: "Address", width: "17%", sortKey: "address" },
  // Truncates by design and carries the full value in a title tooltip.
  { label: "Category", width: "10%", sortKey: "category" },
  { label: "Website", width: "13%" },
  // Sized against their longest content: "Not interested" as a chip, and a
  // date with a time beside it.
  { label: "Status", width: "11%" },
  // One 28px glyph, so this is the narrowest column in the table by some way —
  // the quick upload is an action beside the status, not a feature of the list,
  // and giving it a chip's worth of room would say otherwise. The four scraped
  // columns each gave up a point to pay for it rather than the table growing.
  { label: "Audio", width: "5%" },
  { label: "Booked", width: "8%" },
];

/**
 * The same table, in Demo mode.
 *
 * **The same columns**, in the same order, at the same widths where they fit —
 * this is the worklist looking at the same leads, and an agent who moves
 * between the two views should not have to re-learn where the phone number is.
 *
 * One column is swapped and one is added. Audio goes, because the demo view has
 * no audio: a demo is presented with a picture and a link, and a recording
 * control here would be the one thing this view is specified not to have. In
 * its place go Demo image and Demo link, which are the only two facts this view
 * knows that the worklist does not.
 *
 * The nine columns are paid for out of the eight, a point or two each, rather
 * than by widening the table: the worklist already scrolls sideways below
 * 1180px and adding to that would push the business name off a laptop.
 */
const DEMO_COLUMNS: Column[] = [
  { label: "Business", width: "21%", sortKey: "name" },
  { label: "Phone", width: "12%", sortKey: "phone" },
  { label: "Address", width: "15%", sortKey: "address" },
  { label: "Category", width: "9%", sortKey: "category" },
  { label: "Website", width: "11%" },
  { label: "Status", width: "10%" },
  // Narrow: a 28px control and a 36px thumbnail, the same footprint the Audio
  // column had, because it is the same kind of thing — one action beside the
  // row rather than a feature of the list.
  { label: "Demo image", width: "7%" },
  // Wider than the image cell: it holds a hostname, and one that truncates to
  // three characters would be a column that says nothing.
  { label: "Demo link", width: "9%" },
  { label: "Booked", width: "6%" },
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
  section = "leads",
  sort,
  onSort,
  hrefFor,
  onOpen,
  datasetKey,
  recordings,
  onRecordingSaved,
  demos,
  onDemoSaved,
}: {
  leads: Lead[];
  today: string;
  /**
   * Which view is drawing. Decides the last three columns and nothing else —
   * the rows, the ordering and the pager are identical, because they are the
   * same leads answered by the same query.
   */
  section?: LeadSection;
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
  /**
   * Call recordings the signed-in user may see, keyed by lead. Fetched once by
   * `Worklist` for the whole screen rather than per row, and deliberately not
   * part of the paged leads query — see `app/api/recordings/route.ts`.
   */
  recordings: Record<string, RecordingSummary>;
  /** A quick upload that landed. Updates one entry in the map above. */
  onRecordingSaved: (recording: RecordingSummary) => void;
  /**
   * Demo image and link for the rows on this page, keyed by lead id.
   *
   * **Sparse.** A lead with neither is simply absent, and is drawn with an
   * empty image cell and "Add link" — which is how every lead that predates
   * this feature appears, with nothing having been backfilled. Only populated
   * in the demo section; the worklist passes nothing and draws neither column.
   */
  demos?: DemoSummaryMap;
  /** A demo image or link that was just saved from a row. */
  onDemoSaved?: (leadId: string, demo: DemoSummary) => void;
}) {
  const demo = section === "demo";
  const columns = demo ? DEMO_COLUMNS : COLUMNS;
  return (
    // No panel of its own: the table is the body of the workspace surface,
    // between the toolbar strip above it and the pager strip below. Only the
    // rows scroll — the toolbar and the pager stay put, which is what makes a
    // long list feel like a window onto data rather than a long page.
    <div className="min-h-0 flex-1 overflow-auto">
      {/* 60px more than before, which is what the Audio column needs to hold a
          28px control between the same 12px gutters every other cell uses. */}
      <table className="lead-table lead-table-frozen w-full min-w-[1180px] table-fixed border-collapse">
        <colgroup>
          {columns.map((column) => (
            <col key={column.label} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column, index) => {
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
              section={section}
              href={hrefFor(lead, index)}
              onOpen={() => onOpen(index)}
              recording={recordings[lead.id] ?? null}
              onRecordingSaved={onRecordingSaved}
              demo={demos?.[lead.id] ?? null}
              onDemoSaved={onDemoSaved}
            />
          ))}
          {leads.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-5 py-20 text-center">
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
