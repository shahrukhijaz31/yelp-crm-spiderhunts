"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  X,
} from "lucide-react";

import Pagination from "./Pagination";
import {
  formatClock,
  formatDayLabel,
  formatFileSize,
  formatTimeOfDay,
  parseTimeOfDay,
} from "@/lib/screenshotViewerRules";
import {
  buildMyScreenshotParams,
  defaultMyScreenshotQuery,
  MY_DATE_PRESETS,
  MY_DATE_PRESET_LABELS,
  MY_SCREENSHOT_PAGE_SIZES,
  type MyDatePreset,
  type MyScreenshotCard,
  type MyScreenshotPageSize,
  type MyScreenshotPayload,
  type MyScreenshotQuery,
  type MyWorkSessionOption,
} from "@/lib/myScreenshotsRules";

/**
 * My screenshots — the agent's own captures, on their own performance page.
 *
 * **It shows and it does nothing else.** There is no tick box, no trash icon,
 * no bulk bar, no upload control and no retention setting anywhere in this
 * file, and their absence is not a styling decision that a later edit might
 * reverse: the endpoint behind this exports `GET` and only `GET`, and the
 * module behind that contains no write of any kind (`lib/myScreenshots.ts`).
 * Deleting a screenshot remains an administrator's action against a different
 * API. Compare `ScreenshotsPanel`, the admin screen, which has all of those
 * controls and is not reachable by an agent at either end.
 *
 * **The filter bar has no agent picker, and cannot grow one.** That is the one
 * visible difference from the admin screen and the reason the two are separate
 * components. Everything here narrows a list whose owner was decided by the
 * session row before the request was parsed — the query type this builds has no
 * field for a person, so there is nothing for a control to bind to. The work
 * session picker lists only this reader's own shifts, and a shift id from
 * anywhere else selects nothing rather than somebody.
 *
 * **A page at a time.** The first page is rendered by the server and handed in,
 * so opening the performance page costs one round trip rather than two and the
 * grid is never briefly empty. Every filter change and page turn after that is
 * a fetch. Thumbnails stay `loading="lazy"`, so a page of ninety-six costs the
 * two rows that are actually scrolled to.
 */
export default function MyScreenshotsPanel({
  initialPayload,
  serverToday,
}: {
  initialPayload: MyScreenshotPayload;
  /** The server's day, so "Today" means the same thing at both ends. */
  serverToday: string;
}) {
  const [query, setQuery] = useState<MyScreenshotQuery>(() =>
    defaultMyScreenshotQuery(serverToday),
  );
  const [payload, setPayload] = useState(initialPayload);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Index into the current page, or null when the preview is closed. */
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // Identifies the request in flight, so a slow "all dates" cannot land on top
  // of the "today" asked for afterwards. The same guard the worklist, the team
  // report and the admin viewer use, for the same reason.
  const requestId = useRef(0);

  const load = useCallback(async (next: MyScreenshotQuery) => {
    const id = (requestId.current += 1);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/performance/me/screenshots?${buildMyScreenshotParams(next)}`,
        { credentials: "same-origin" },
      );
      if (id !== requestId.current) return;

      if (!response.ok) {
        setError(
          response.status === 401
            ? "Your session has ended. Sign in again to continue."
            : "Could not load your screenshots. Try again.",
        );
        return;
      }

      const body = (await response.json()) as MyScreenshotPayload;
      if (id !== requestId.current) return;
      setPayload(body);
    } catch {
      if (id === requestId.current) setError("Could not reach the server.");
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  // Skips the first run: the server rendered this exact payload, and asking for
  // it again on mount would be a wasted round trip and a visible flicker on a
  // section that was already correct.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void load(query);
  }, [load, query]);

  /**
   * Change the filter.
   *
   * Every edit except paging returns to page one. Landing on page 4 of a filter
   * that now has one page is a blank grid that looks like "no screenshots" and
   * is really "no such page".
   */
  const amend = useCallback((patch: Partial<MyScreenshotQuery>) => {
    setOpenIndex(null);
    setQuery((current) => ({ ...current, ...patch, page: 1 }));
  }, []);

  const { screenshots, meta, sessions } = payload;
  const open = openIndex === null ? null : (screenshots[openIndex] ?? null);
  const timeDisabled = query.preset === "all";

  return (
    <section aria-labelledby="my-screenshots-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="my-screenshots-heading" className="text-caption font-medium text-fg-2">
          Screenshots
        </h2>
        <p className="text-meta text-fg-4">
          Captured by the Monitor while you were on the clock. Newest first.
        </p>
      </div>

      {/* --- filters ------------------------------------------------------ */}
      {/* No agent control here and no room for one — see the note at the top of
          this file. Everything below narrows your own list. */}
      <div
        aria-label="Screenshot filters"
        className="panel flex flex-wrap items-end gap-3 px-4 py-3"
      >
        <Field label="Date" htmlFor="my-ss-date">
          <Select
            id="my-ss-date"
            value={query.preset}
            onChange={(value) => {
              const preset = value as MyDatePreset;
              amend({
                preset,
                day: dayFor(preset, query.day, serverToday),
                // A shift belongs to one day, so a date change would otherwise
                // leave a selection that filters to a day the shift was not on
                // and shows nothing.
                workSessionId: null,
              });
            }}
            options={MY_DATE_PRESETS.map((preset) => ({
              value: preset,
              label: MY_DATE_PRESET_LABELS[preset],
            }))}
          />
        </Field>

        {query.preset === "custom" && (
          <Field label="Day" htmlFor="my-ss-day">
            <input
              id="my-ss-day"
              type="date"
              value={query.day}
              max={serverToday}
              onChange={(event) =>
                amend({ day: event.target.value, workSessionId: null })
              }
              className="ui-field h-9 w-[152px]"
            />
          </Field>
        )}

        <Field label="Work session" htmlFor="my-ss-session">
          <Select
            id="my-ss-session"
            value={query.workSessionId ?? "all"}
            onChange={(value) =>
              amend({ workSessionId: value === "all" ? null : value })
            }
            options={[
              { value: "all", label: "All sessions" },
              ...sessions.map((session) => ({
                value: session.id,
                label: sessionLabel(session, serverToday),
              })),
            ]}
            disabled={sessions.length === 0}
          />
        </Field>

        {/* Time of day needs a day to be a time *of*. On "All dates" the
            control is disabled rather than hidden, so the bar does not change
            width as the date filter is used, and the server drops the values
            anyway — see `resolveMyScreenshotQuery`. */}
        <Field label="From" htmlFor="my-ss-from">
          <input
            id="my-ss-from"
            type="time"
            value={formatTimeOfDay(query.fromMinutes)}
            disabled={timeDisabled}
            title={timeDisabled ? "Choose a date to filter by time of day" : undefined}
            onChange={(event) =>
              amend({ fromMinutes: parseTimeOfDay(event.target.value) })
            }
            className="ui-field h-9 w-[112px] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </Field>

        <Field label="To" htmlFor="my-ss-to">
          <input
            id="my-ss-to"
            type="time"
            value={formatTimeOfDay(query.toMinutes)}
            disabled={timeDisabled}
            title={timeDisabled ? "Choose a date to filter by time of day" : undefined}
            onChange={(event) => amend({ toMinutes: parseTimeOfDay(event.target.value) })}
            className="ui-field h-9 w-[112px] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </Field>

        {(query.fromMinutes !== null || query.toMinutes !== null) && (
          <button
            type="button"
            onClick={() => amend({ fromMinutes: null, toMinutes: null })}
            className="ui-btn ui-btn-ghost h-9 px-2.5 text-caption"
          >
            Clear time
          </button>
        )}

        <p className="ml-auto self-center text-meta text-fg-4" aria-live="polite">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : busy ? (
            "Loading…"
          ) : (
            windowCaption(query)
          )}
        </p>
      </div>

      {/* --- the gallery --------------------------------------------------- */}
      <div className="panel overflow-hidden">
        {error && screenshots.length === 0 ? (
          <Empty
            title="Your screenshots could not be loaded"
            body="The server could not be reached. The filters above are unchanged, so trying again will ask for the same view."
          />
        ) : busy && screenshots.length === 0 ? (
          <SkeletonGrid count={8} />
        ) : screenshots.length === 0 ? (
          <Empty title="No screenshots found" body={emptyReason(query)} />
        ) : (
          <div
            className={`grid gap-3 p-3 transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${
              busy ? "opacity-60" : ""
            }`}
          >
            {screenshots.map((card, index) => (
              <Card
                key={card.id}
                screenshot={card}
                today={serverToday}
                onOpen={() => setOpenIndex(index)}
              />
            ))}
          </div>
        )}

        {/* The pager stays under an empty grid: it is what says "page 3 of 1",
            which is the fastest way to understand a screen that is empty
            because of where you are rather than because of what exists. */}
        <Pagination
          page={meta.page}
          pageSize={meta.pageSize}
          total={meta.total}
          totalPages={meta.totalPages}
          busy={busy}
          onPageChange={(page) => {
            setOpenIndex(null);
            setQuery((current) => ({ ...current, page }));
          }}
          onPageSizeChange={(pageSize: MyScreenshotPageSize) => amend({ pageSize })}
          pageSizes={MY_SCREENSHOT_PAGE_SIZES}
          noun="screenshots"
          emptyLabel="No screenshots match the current filters"
          label="Screenshot pages"
        />
      </div>

      {open && openIndex !== null && (
        <Preview
          screenshot={open}
          today={serverToday}
          positionLabel={`${(meta.page - 1) * meta.pageSize + openIndex + 1} of ${meta.total.toLocaleString()}`}
          onClose={() => setOpenIndex(null)}
          onPrevious={openIndex > 0 ? () => setOpenIndex(openIndex - 1) : null}
          onNext={
            openIndex < screenshots.length - 1 ? () => setOpenIndex(openIndex + 1) : null
          }
        />
      )}
    </section>
  );
}

/** The image URL for a card. The one place this component names an endpoint. */
function imageSrc(id: string): string {
  return `/api/performance/me/screenshots/${encodeURIComponent(id)}/image`;
}

/* -------------------------------------------------------------------------- */
/* One card                                                                   */
/* -------------------------------------------------------------------------- */

function Card({
  screenshot,
  today,
  onOpen,
}: {
  screenshot: MyScreenshotCard;
  today: string;
  onOpen: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition-all duration-200 hover:border-line-2 hover:shadow-[var(--c-shadow-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]"
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-recessed">
        {status === "loading" && (
          <div className="skeleton absolute inset-0" aria-hidden="true" />
        )}

        {status === "failed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-center">
            <ImageOff className="h-5 w-5 text-fg-4" strokeWidth={1.5} aria-hidden="true" />
            <p className="text-meta text-fg-3">Image unavailable</p>
          </div>
        ) : (
          /*
           * A plain `img` rather than `next/image`, for the reason the admin
           * grid gives: this is an authenticated byte stream behind a session
           * cookie, not a static asset the optimiser could fetch, cache or
           * rewrite. Putting it through the image pipeline would mean a second
           * copy of somebody's desktop in a cache that has no session in it.
           *
           * `loading="lazy"` is what makes a page of ninety-six affordable:
           * only the cards scrolled to are ever requested.
           */
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated byte stream, not an optimisable static asset.
          <img
            src={imageSrc(screenshot.id)}
            alt={`Your desktop at ${formatClock(screenshot.capturedAt)}`}
            loading="lazy"
            decoding="async"
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("failed")}
            className={`h-full w-full object-cover object-top transition-all duration-300 group-hover:scale-[1.015] ${
              status === "ready" ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-line px-3 py-2.5">
        <p className="tnum flex items-center gap-1.5 font-mono text-meta text-fg-2">
          <span>{formatDayLabel(screenshot.capturedAt, today)}</span>
          <span aria-hidden="true" className="text-fg-4">
            ·
          </span>
          <span>{formatClock(screenshot.capturedAt)}</span>
        </p>
        <p className="tnum flex items-center gap-1.5 font-mono text-meta text-fg-4">
          <span>
            {screenshot.width} × {screenshot.height}
          </span>
          {screenshot.activityPercentage !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span title="Keyboard and mouse activity in the minute this was taken">
                {screenshot.activityPercentage}% activity
              </span>
            </>
          )}
        </p>
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* The larger preview                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One capture, large, over the page it was opened from.
 *
 * Deliberately a separate component from `ScreenshotViewer` rather than that
 * one taught a second image URL. The admin viewer is built around a
 * `ScreenshotCard`, which carries the agent it belongs to and shows that name
 * as a heading — a field this payload does not have and must not grow. Two
 * small components that each say plainly whose screenshot they are showing
 * beat one with a "whose is this" branch through the middle of it.
 */
function Preview({
  screenshot,
  today,
  positionLabel,
  onClose,
  onPrevious,
  onNext,
}: {
  screenshot: MyScreenshotCard;
  today: string;
  positionLabel: string;
  onClose: () => void;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);

  // Reset during render rather than in an effect, so the previous picture is
  // never painted under the next one's caption.
  const [shownId, setShownId] = useState(screenshot.id);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  if (shownId !== screenshot.id) {
    setShownId(screenshot.id);
    setStatus("loading");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowRight" && onNext) {
        event.preventDefault();
        onNext();
      } else if (event.key === "ArrowLeft" && onPrevious) {
        event.preventDefault();
        onPrevious();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, onNext, onPrevious]);

  // The page behind must not scroll while this is open. The padding swap keeps
  // the shell from shifting sideways as the scrollbar goes.
  useEffect(() => {
    const { body } = document;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const overflow = body.style.overflow;
    const padding = body.style.paddingRight;

    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;

    return () => {
      body.style.overflow = overflow;
      body.style.paddingRight = padding;
    };
  }, []);

  // Focus in on open, back to the card on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const capturedDay = formatDayLabel(screenshot.capturedAt, today);

  return (
    <div
      className="lead-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Your screenshot from ${capturedDay} at ${formatClock(screenshot.capturedAt)}`}
    >
      <motion.button
        type="button"
        aria-label="Close the screenshot"
        onClick={onClose}
        className="lead-overlay-scrim"
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      />

      <motion.div
        ref={panelRef}
        tabIndex={-1}
        className="lead-overlay-panel outline-none"
        initial={reduced ? false : { opacity: 0, scale: 0.985, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
          <Camera
            className="h-4 w-4 shrink-0 text-fg-4"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="truncate text-ui font-semibold tracking-[-0.01em] text-fg">
              My screenshot
            </p>
            <p className="tnum shrink-0 font-mono text-caption text-fg-3">
              {capturedDay} · {formatClock(screenshot.capturedAt)}
            </p>
          </div>

          <p className="tnum ml-auto shrink-0 font-mono text-meta text-fg-4 max-sm:hidden">
            {positionLabel}
          </p>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ws-window-close"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        {/* `bg-base` rather than the panel surface: a screenshot is usually a
            bright desktop, and a darker floor is what stops the letterboxing
            from reading as part of the image. */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-base">
          {status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="skeleton h-full w-full" aria-hidden="true" />
              <p className="absolute text-caption text-fg-3">Loading the full image…</p>
            </div>
          )}

          {status === "failed" ? (
            <div className="flex flex-col items-center gap-2 px-6 text-center">
              <ImageOff className="h-6 w-6 text-fg-4" strokeWidth={1.5} aria-hidden="true" />
              <p className="text-ui font-medium text-fg">This image could not be loaded</p>
              <p className="max-w-sm text-caption text-fg-3">
                The record exists, but its image file could not be read from
                storage. It may have been removed by the retention sweep.
              </p>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- an authenticated byte stream, not an optimisable static asset.
            <img
              key={screenshot.id}
              src={imageSrc(screenshot.id)}
              alt={`Your desktop, captured at ${formatClock(screenshot.capturedAt)}`}
              width={screenshot.width}
              height={screenshot.height}
              onLoad={() => setStatus("ready")}
              onError={() => setStatus("failed")}
              className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${
                status === "ready" ? "opacity-100" : "opacity-0"
              }`}
            />
          )}

          <StepButton side="left" onClick={onPrevious} />
          <StepButton side="right" onClick={onNext} />
        </div>

        <div className="ws-window-foot justify-between gap-x-6">
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
            <Fact
              label="Captured"
              value={`${capturedDay} · ${formatClock(screenshot.capturedAt)}`}
              mono
            />
            <Fact
              label="Work session"
              value={
                screenshot.workSession
                  ? `${formatDayLabel(screenshot.workSession.startedAt, today)} · ${sessionSpan(screenshot.workSession)}`
                  : // Never invented. A capture with no shift is a row this
                    // schema does not currently allow, and saying so is the
                    // only honest thing to show if one ever appears.
                    "Unavailable"
              }
              mono={screenshot.workSession !== null}
            />
            <Fact
              label="Resolution"
              value={`${screenshot.width} × ${screenshot.height}`}
              mono
            />
            <Fact label="Size" value={formatFileSize(screenshot.fileSize)} mono />
            {screenshot.activityPercentage !== null && (
              <Fact label="Activity" value={`${screenshot.activityPercentage}%`} mono />
            )}
          </dl>

          <p className="text-meta text-fg-4 max-lg:hidden">
            <kbd className="font-mono">←</kbd> <kbd className="font-mono">→</kbd> to move ·{" "}
            <kbd className="font-mono">Esc</kbd> to close
          </p>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * One edge chevron. Rendered even when there is nowhere to go, as a disabled
 * control, so the image does not jump at the ends of a page.
 */
function StepButton({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: (() => void) | null;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      onClick={onClick ?? undefined}
      disabled={onClick === null}
      aria-label={side === "left" ? "Previous screenshot" : "Next screenshot"}
      className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-2" : "right-2"} inline-flex h-10 w-10 items-center justify-center rounded-full border border-line-2 bg-surface/85 text-fg-2 backdrop-blur transition-all duration-150 hover:bg-surface hover:text-fg disabled:pointer-events-none disabled:opacity-0`}
    >
      <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-0.5 truncate text-caption text-fg-2 ${mono ? "tnum font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="field-label">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A native `<select>`, styled — the same one the admin viewer and the team
 * report use, and not a custom listbox for the same reason: the platform
 * control is better than anything that would be built here and comes with
 * keyboard and screen-reader behaviour for free.
 */
function Select({
  id,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="ui-field h-9 min-w-[168px] appearance-none pr-8 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-4"
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  );
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div
      className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-lg border border-line">
          <div className="skeleton aspect-[16/10] w-full" />
          <div className="flex flex-col gap-2 border-t border-line px-3 py-3">
            <div className="skeleton h-3 w-1/2 rounded" />
            <div className="skeleton h-2.5 w-2/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Camera className="h-6 w-6 text-fg-4" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-ui font-medium text-fg">{title}</p>
      {/* No placeholder cards behind this. An empty gallery showing greyed
          rectangles reads as "loading" forever. */}
      <p className="max-w-md text-caption text-fg-3">{body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/** Why this grid is empty, said as specifically as the filters allow. */
function emptyReason(query: MyScreenshotQuery): string {
  const span =
    query.fromMinutes !== null || query.toMinutes !== null
      ? ` between ${formatTimeOfDay(query.fromMinutes) || "00:00"} and ${formatTimeOfDay(query.toMinutes) || "24:00"}`
      : "";

  if (query.workSessionId) {
    return `None of your screenshots fall in the selected work session${span}.`;
  }

  if (query.preset === "all") {
    return "Screenshots are captured by the SpiderHunts Monitor while you are signed in to it and on the clock. Once you have worked a shift with the Monitor running, they will appear here.";
  }

  const when =
    query.preset === "today"
      ? "today"
      : query.preset === "yesterday"
        ? "yesterday"
        : `on ${query.day}`;

  return `None of your screenshots were captured ${when}${span}. Screenshots are only taken while you are signed in to the Monitor and on the clock.`;
}

/** "All dates" / "Today · all day" / "2026-08-12 · 09:00–17:00". */
function windowCaption(query: MyScreenshotQuery): string {
  if (query.preset === "all") return "All dates";

  const day =
    query.preset === "today"
      ? "Today"
      : query.preset === "yesterday"
        ? "Yesterday"
        : query.day;

  if (query.fromMinutes === null && query.toMinutes === null) {
    return `${day} · all day`;
  }

  return `${day} · ${formatTimeOfDay(query.fromMinutes) || "00:00"}–${
    formatTimeOfDay(query.toMinutes) || "24:00"
  }`;
}

/** Which day a preset means, when the picker is switched. */
function dayFor(preset: MyDatePreset, currentDay: string, today: string): string {
  if (preset === "today") return today;
  if (preset === "custom") return currentDay;
  if (preset === "all") return today;
  // "Yesterday" is resolved on the server from its own clock; this is only what
  // the date input shows until the response lands.
  const date = new Date(`${today}T00:00:00`);
  date.setDate(date.getDate() - 1);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * A shift in the picker: which day, its span, and how many captures it holds.
 *
 * The count is what makes the list usable — two shifts are told apart far
 * faster by "34 shots" than by two timestamps that differ by minutes. It is a
 * real count from the database, never an estimate, and it counts the whole
 * shift rather than the current filter, which is why a session can read
 * "34 shots" while the grid under a narrow time filter shows four.
 */
function sessionLabel(session: MyWorkSessionOption, today: string): string {
  const day = formatDayLabel(session.startedAt, today);
  const shots = `${session.screenshotCount} shot${session.screenshotCount === 1 ? "" : "s"}`;
  return `${day} · ${sessionSpan(session)} · ${shots}`;
}

function sessionSpan(session: { startedAt: string; endedAt: string | null }): string {
  const started = formatClock(session.startedAt, false);
  return session.endedAt
    ? `${started} – ${formatClock(session.endedAt, false)}`
    : `${started} – now`;
}
