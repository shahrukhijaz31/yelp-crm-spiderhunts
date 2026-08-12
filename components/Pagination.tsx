"use client";

import { PAGE_SIZES, type PageSize } from "@/lib/leadQuery";

/**
 * The pager: a count on the left, the controls on the right.
 *
 * Deliberately quiet. It was built for the worklist, where it sits directly
 * under an eight-column table an agent reads all day, so it borrows the table's
 * own chrome — the same `border-line` hairline, the same `bg-surface`, the
 * `ui-field` control chassis for the selector and the mono numerals the rest of
 * the app uses for figures — rather than arriving as a component with opinions
 * of its own. The only saturated colour is the accent on the current page,
 * which is the one thing here that has to be findable at a glance.
 *
 * On a narrow screen the two halves stack and the row wraps; the page numbers
 * are the first thing to lose room, which is why Previous and Next carry the
 * words as well as the chevrons.
 *
 * **Two callers now, one component.** The screenshot viewer pages a grid rather
 * than a table, which needs a different noun in the count and a different set
 * of page sizes (a card is twenty times the area of a row, so ten of them is
 * not a useful option). Both arrive as optional props that default to what the
 * worklist has always passed, so the worklist's markup, copy and behaviour are
 * byte-for-byte what they were — the alternative was a second pager that would
 * drift from this one the first time either was touched.
 */
export default function Pagination<Size extends number = PageSize>({
  page,
  pageSize,
  total,
  totalPages,
  busy,
  onPageChange,
  onPageSizeChange,
  noun = "leads",
  emptyLabel = "No leads match the current view",
  pageSizes = PAGE_SIZES as unknown as readonly Size[],
  label = "Lead list pages",
}: {
  page: number;
  pageSize: number;
  /** Rows matching the current tab and filters, not the size of the table. */
  total: number;
  totalPages: number;
  /** A fetch is in flight — the controls stay legible but stop accepting input. */
  busy: boolean;
  onPageChange: (page: number) => void;
  /**
   * Typed to whatever `pageSizes` offers, so a caller cannot be handed a size
   * that was never in its own selector — `Size` is inferred from the two
   * together, and the worklist, which passes neither, gets `PageSize` as before.
   */
  onPageSizeChange: (pageSize: Size) => void;
  /** Plural noun for the count: "1–20 of 340 <noun>". */
  noun?: string;
  /** What the left side says when nothing matched. */
  emptyLabel?: string;
  /** The options in the per-page selector. */
  pageSizes?: readonly Size[];
  /** Accessible name for the `<nav>`. */
  label?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const onFirstPage = page <= 1;
  const onLastPage = page >= totalPages;

  return (
    <nav
      aria-label={label}
      // No panel and no margin: this is the footer strip of the workspace
      // surface, joined to the table above it by one hairline. A pager in its
      // own floating card is a pager that has been detached from the thing it
      // pages.
      className="panel-rail flex flex-col gap-3 border-t border-line px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
    >
      {/* --- left: what you are looking at --------------------------------- */}
      {/* `aria-live` so a screen reader hears the new range after a page turn;
          the buttons themselves say nothing about where they landed. */}
      <p aria-live="polite" className="text-caption text-fg-3">
        {total === 0 ? (
          emptyLabel
        ) : (
          <>
            <span className="tnum font-mono font-medium text-fg-2">
              {first.toLocaleString()}–{last.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="tnum font-mono text-fg-2">{total.toLocaleString()}</span>{" "}
            {noun}
            {/* The page position, stated in words as well as drawn as buttons.
                On a narrow screen the numbers collapse to a gap and this is
                the only thing left saying where you are. */}
            <span className="text-fg-4">
              {" "}
              · page <span className="tnum font-mono">{page}</span> of{" "}
              <span className="tnum font-mono">{Math.max(totalPages, 1)}</span>
            </span>
          </>
        )}
      </p>

      {/* --- right: how many, and which ------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex shrink-0 items-center gap-2 text-caption text-fg-3">
          <span className="whitespace-nowrap">Rows per page</span>
          <select
            value={pageSize}
            disabled={busy}
            onChange={(event) =>
              onPageSizeChange(Number(event.target.value) as Size)
            }
            // Shorter than the shared 2.25rem chassis: a four-option numeric
            // select next to a row of page buttons should not be the tallest
            // thing in the bar.
            className="ui-field h-8 w-[4.5rem] cursor-pointer px-2"
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <StepButton
            direction="previous"
            disabled={busy || onFirstPage}
            onClick={() => onPageChange(page - 1)}
          />

          {pageItems(page, totalPages).map((item, index) =>
            item === "gap" ? (
              <span
                key={`gap-${index}`}
                aria-hidden="true"
                className="px-0.5 text-caption text-fg-4"
              >
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                disabled={busy}
                aria-label={`Page ${item}`}
                aria-current={item === page ? "page" : undefined}
                onClick={() => onPageChange(item)}
                // The current page is a filled surface, not a filled *accent*.
                // A red button in a row of page numbers reads as an action —
                // "press me" — when it is actually a statement of where you
                // already are. Red is spent on the primary action and on
                // overdue work, and a pager is neither.
                className={`tnum h-7 min-w-7 rounded-md px-1.5 font-mono text-caption transition-colors disabled:cursor-not-allowed ${
                  item === page
                    ? "border border-line-2 bg-surface font-medium text-fg"
                    : "text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-50"
                }`}
              >
                {item}
              </button>
            ),
          )}

          <StepButton
            direction="next"
            disabled={busy || onLastPage}
            onClick={() => onPageChange(page + 1)}
          />
        </div>
      </div>
    </nav>
  );
}

function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  const label = direction === "previous" ? "Previous" : "Next";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="ui-btn ui-btn-secondary h-7 gap-1 px-2 text-caption"
    >
      {direction === "previous" && <Chevron pointing="left" />}
      {/* The word is the label on a wide screen; below `sm` the glyph carries
          it alone and the accessible name comes from `aria-label` above. */}
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
      {direction === "next" && <Chevron pointing="right" />}
    </button>
  );
}

function Chevron({ pointing }: { pointing: "left" | "right" }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path
        d={pointing === "left" ? "M7.5 2.5 4 6l3.5 3.5" : "M4.5 2.5 8 6l-3.5 3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Which page numbers to draw.
 *
 * 87 pages is 87 buttons an agent has to look past to find the one they want,
 * so the list is always the two ends, the current page and its immediate
 * neighbours, with a gap standing in for the rest: `1 … 43 44 45 … 87`.
 *
 * The width is fixed at seven slots whatever the page, which is the point — a
 * pager whose buttons move under the cursor as you step through it is worse
 * than one that shows fewer numbers. Below eight pages there is nothing to
 * elide and every page is listed.
 */
export function pageItems(page: number, totalPages: number): Array<number | "gap"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const items: Array<number | "gap"> = [1];

  // Near either end the window is pushed inwards, so the run of numbers stays
  // the same length instead of collapsing against the first or last page.
  let start = Math.max(2, page - 1);
  let end = Math.min(totalPages - 1, page + 1);
  if (page <= 3) end = 4;
  if (page >= totalPages - 2) start = totalPages - 3;

  if (start > 2) items.push("gap");
  for (let candidate = start; candidate <= end; candidate += 1) items.push(candidate);
  if (end < totalPages - 1) items.push("gap");

  items.push(totalPages);
  return items;
}
