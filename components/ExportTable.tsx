"use client";

import { useEffect, useRef } from "react";

import WhatsAppLink from "./WhatsAppLink";
import { callbackState, formatCallbackDate } from "@/lib/leadUtils";
import { CALL_STATUS_DOTS, CALL_STATUS_SHORT_LABELS, type Lead } from "@/lib/types";

/** Rows rendered before we stop and just say how many more there are. */
const RENDER_LIMIT = 150;

/**
 * The Export view's working table: it lists exactly the rows the chosen scope
 * will write, and its checkboxes are the only place rows are ticked.
 *
 * Keeping selection on this one screen is deliberate. Ticking on the worklist
 * and spending the result here meant an agent could never see what they had
 * chosen at the moment they chose to export it.
 */
export default function ExportTable({
  leads,
  today,
  selectedIds,
  onToggle,
  onToggleAll,
  emptyMessage,
}: {
  leads: Lead[];
  today: string;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (selectAll: boolean) => void;
  emptyMessage: string;
}) {
  const shown = leads.slice(0, RENDER_LIMIT);
  const overflow = leads.length - shown.length;

  const selectedHere = leads.filter((lead) => selectedIds.has(lead.id)).length;
  const allSelected = leads.length > 0 && selectedHere === leads.length;
  const someSelected = selectedHere > 0 && !allSelected;

  // `indeterminate` is a DOM property with no HTML attribute.
  const headerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someSelected;
  }, [someSelected]);

  if (leads.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-2 bg-surface px-4 py-8 text-center text-ui text-fg-3">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="max-h-[420px] overflow-auto rounded-xl border border-line bg-surface">
      <table className="lead-table w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "30%" }} />
          <col style={{ width: "17%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "12%" }} />
        </colgroup>
        <thead>
          <tr>
            <th
              scope="col"
              className="border-b border-line-2 bg-surface py-2.5 pl-4 pr-1 text-left"
            >
              <input
                ref={headerRef}
                type="checkbox"
                checked={allSelected}
                onChange={(event) => onToggleAll(event.target.checked)}
                aria-label={
                  allSelected ? "Untick every row listed" : "Tick every row listed"
                }
                className="h-3.5 w-3.5 cursor-pointer accent-accent"
              />
            </th>
            {["Business", "Phone", "Category", "Status", "Callback"].map((label) => (
              <th
                key={label}
                scope="col"
                className="col-head border-b border-line-2 bg-surface px-3 py-3 text-left"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((lead) => {
            const selected = selectedIds.has(lead.id);
            const state = callbackState(lead, today);
            return (
              <tr
                key={lead.id}
                className={`group border-b border-line/70 last:border-0 transition-colors ${
                  selected ? "bg-accent-soft/40" : "hover:bg-hover"
                }`}
              >
                <td className="py-1.5 pl-4 pr-1">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggle(lead.id)}
                    aria-label={`Select ${lead.name}`}
                    className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  />
                </td>
                <td
                  className="truncate px-3 py-2 text-ui font-semibold text-fg"
                  title={lead.name}
                >
                  {lead.name}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span className="tnum font-mono text-ui text-fg">
                      {lead.phone}
                    </span>
                    <WhatsAppLink phone={lead.phone} leadName={lead.name} />
                  </span>
                </td>
                <td
                  className="truncate px-3 py-2 text-ui text-fg-3"
                  title={lead.categories.join(", ")}
                >
                  {lead.categories.slice(0, 2).join(", ") || "—"}
                </td>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-2 text-ui text-fg-2">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${CALL_STATUS_DOTS[lead.status]}`}
                    />
                    <span className="truncate">
                      {CALL_STATUS_SHORT_LABELS[lead.status]}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  {lead.callbackDate ? (
                    <span
                      className={`tnum font-mono text-caption ${
                        state === "overdue" || state === "today"
                          ? "text-accent"
                          : "text-fg-3"
                      }`}
                    >
                      {formatCallbackDate(lead.callbackDate, today)}
                    </span>
                  ) : (
                    <span className="text-caption text-fg-3">— —</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {overflow > 0 && (
        <p className="border-t border-line px-4 py-2.5 text-caption text-fg-3">
          …and <span className="tnum font-mono">{overflow}</span> more, also
          included in the file.
        </p>
      )}
    </div>
  );
}
