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
  { label: "Business", width: "16%" },
  // Wider than the number needs: it also carries the WhatsApp glyph, and the
  // cell never wraps, so a tight column would clip one or the other.
  { label: "Phone", width: "11%" },
  { label: "Address", width: "15%" },
  { label: "Category", width: "10.5%" },
  { label: "Website", width: "11%" },
  { label: "Status", width: "10.5%", working: true },
  { label: "Callback", width: "8.5%", working: true },
  { label: "Notes", width: "17.5%", working: true },
];

/** The whole list, always rendered in full — no pagination, no detail pages. */
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
    <div className="flex-1 overflow-auto rounded-xl border border-line bg-surface">
      <table className="lead-table w-full min-w-[1380px] table-fixed border-collapse">
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
                className={`eyebrow border-b border-line-2 bg-surface py-3 text-left ${
                  index === 0 ? "pl-[19px] pr-3" : "px-3"
                } ${column.working ? "text-fg-2" : ""} ${
                  column.label === "Status" ? "border-l border-line" : ""
                }`}
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
              <td colSpan={COLUMNS.length} className="px-5 py-16 text-center">
                <p className="display-num text-[20px] text-fg-3">Nothing here</p>
                <p className="mt-1.5 text-[13px] text-fg-4">
                  No leads match the current filters.
                </p>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
