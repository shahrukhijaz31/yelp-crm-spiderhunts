"use client";

import { PAGE_SIZES, type PageSize } from "@/lib/leadQuery";

/**
 * The worklist's pager: a count on the left, the controls on the right.
 *
 * Deliberately quiet. It sits directly under an eight-column table an agent
 * reads all day, so it borrows the table's own chrome — the same `border-line`
 * hairline, the same `bg-surface`, the `ui-field` control chassis for the
 * selector and the mono numerals the rest of the app uses for figures — rather
 * than arriving as a component with opinions of its own. The only saturated
 * colour is the accent on the current page, which is the one thing here that
 * has to be findable at a glance.
 *
 * On a narrow screen the two halves stack and the row wraps; the page numbers
 * are the first thing to lose room, which is why Previous and Next carry the
 * words as well as the chevrons.
 */
export default function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  busy,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  /** Rows matching the current tab and filters, not the size of the table. */
  total: number;
  totalPages: number;
  /** A fetch is in flight — the controls stay legible but stop accepting input. */
  busy: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const onFirstPage = page <= 1;
  const onLastPage = page >= totalPages;

  return (
    <nav
      aria-label="Lead list pages"
      className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
    >
      {/* --- left: what you are looking at --------------------------------- */}
      {/* `aria-live` so a screen reader hears the new range after a page turn;
          the buttons themselves say nothing about where they landed. */}
      <p aria-live="polite" className="text-ui text-fg-3">
        {total === 0 ? (
          "No leads match the current view"
        ) : (
          <>
            Showing{" "}
            <span className="tnum font-mono text-num font-semibold text-fg">
              {first.toLocaleString()}–{last.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="tnum font-mono text-num text-fg-2">
              {total.toLocaleString()}
            </span>{" "}
            leads
          </>
        )}
      </p>

      {/* --- right: how many, and which ------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex shrink-0 items-center gap-2 text-ui text-fg-3">
          <span className="whitespace-nowrap">Rows per page</span>
          <select
            value={pageSize}
            disabled={busy}
            onChange={(event) =>
              onPageSizeChange(Number(event.target.value) as PageSize)
            }
            // Shorter than the shared 2.25rem chassis: a four-option numeric
            // select next to a row of page buttons should not be the tallest
            // thing in the bar.
            className="ui-field h-8 w-[4.5rem] cursor-pointer px-2"
          >
            {PAGE_SIZES.map((size) => (
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
                className="px-1 text-ui text-fg-4"
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
                className={`tnum h-8 min-w-8 rounded-lg px-2 font-mono text-caption font-medium transition-colors disabled:cursor-not-allowed ${
                  item === page
                    ? "bg-accent text-on-accent"
                    : "border border-line text-fg-2 hover:border-line-2 hover:bg-hover hover:text-fg disabled:opacity-50"
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
      className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-caption font-medium text-fg-2 transition-colors hover:border-line-2 hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-fg-4 disabled:hover:bg-transparent"
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
