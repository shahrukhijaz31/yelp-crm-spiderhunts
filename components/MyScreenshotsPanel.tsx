"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Camera, ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";

import {
  formatClock,
  formatDayLabel,
  formatFileSize,
  localDayIso,
} from "@/lib/screenshotViewerRules";
import type { MyScreenshotCard, MyScreenshotPayload } from "@/lib/myScreenshotsRules";

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
 * **It cannot be pointed at anybody.** Nothing here sends a user id, because
 * there is nothing here that has one — the fetch below carries a cursor and a
 * page size, and the server resolves the subject from the session row. Editing
 * the request in a console changes the position in this reader's own list and
 * nothing else.
 *
 * **A page at a time, and thumbnails only when they are scrolled to.** The list
 * is cursor-paged rather than fetched whole: an agent with a year of captures
 * loads twenty-four rows, and the next twenty-four when the end of the grid
 * comes into view. Each `<img>` is `loading="lazy"` against the same
 * authenticated byte stream the card would otherwise have downloaded eagerly,
 * so scrolling past is what costs, not opening the page.
 */
export default function MyScreenshotsPanel() {
  const [cards, setCards] = useState<MyScreenshotCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** False until the first response lands, so the empty state cannot flash. */
  const [loaded, setLoaded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  /*
   * "Today" for the day labels, taken once on mount from the browser's clock.
   *
   * The admin screen is handed the server's day because its filters are dates
   * and the two must agree about which day "Today" selects. Nothing here
   * filters by date — the labels are a courtesy on a list that is already in
   * order — so the reader's own midnight is the right one, and it is also the
   * one they would compare against the clock on their wall.
   */
  const [today] = useState(() => localDayIso(new Date()));

  /*
   * One request in flight at a time, tracked in a ref rather than in `busy`.
   *
   * The sentinel below can fire again while a fetch is running — an
   * IntersectionObserver reports on scroll, not on state — and two overlapping
   * requests carrying the same cursor would append the same page twice. State
   * is too late to close that: it is not visible to the callback until the next
   * render.
   */
  const inFlight = useRef(false);

  const loadMore = useCallback(async (from: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (from) params.set("cursor", from);

      const query = params.toString();
      const response = await fetch(
        `/api/performance/me/screenshots${query ? `?${query}` : ""}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }

      const payload = (await response.json()) as MyScreenshotPayload;

      setCards((current) =>
        // Appended rather than replaced, and de-duplicated by id: a capture
        // arriving between two requests cannot make a keyset page overlap, but
        // a retry after a network stall can, and a duplicate key in a grid is
        // a React warning and a card that will not open.
        from === null ? payload.screenshots : dedupe([...current, ...payload.screenshots]),
      );
      setCursor(payload.nextCursor);
      setHasMore(payload.hasMore);
    } catch (cause) {
      console.error("Loading my screenshots failed:", cause);
      setError("Your screenshots could not be loaded. Try again.");
      // The cursor is deliberately left where it was, so the retry asks for the
      // page that failed rather than starting the list again.
      setHasMore(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setLoaded(true);
    }
  }, []);

  /*
   * The sentinel: an empty div at the end of the grid. When it comes into view
   * the next page is asked for, a screen ahead of the reader reaching the end.
   *
   * It drives the *first* page too, which is why there is no fetch-on-mount
   * effect here. Two reasons, and the second is the better one:
   *
   *   - a `setState` run synchronously inside an effect body is a cascading
   *     render, and React's own lint rule says so. An observer callback is the
   *     shape that rule points at instead — an external system telling the
   *     component something changed.
   *   - this section sits at the bottom of the performance page, under the
   *     figures somebody actually came for. Loading a gallery nobody has
   *     scrolled to yet would spend their first request on it. With the margin
   *     below, the fetch starts a screen before the panel is reached, so it is
   *     ready by the time it is looked at and costs nothing if it never is.
   *
   * The button beneath it is not a fallback for a browser without an observer —
   * every browser this portal supports has one — it is there for keyboard and
   * screen-reader users, for whom "scroll until more appears" is not an
   * instruction that can be followed.
   */
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore(cursor);
      },
      { rootMargin: "600px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, hasMore, loadMore]);

  const open = openIndex === null ? null : (cards[openIndex] ?? null);

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

      <div className="panel overflow-hidden">
        {!loaded ? (
          <SkeletonGrid count={8} />
        ) : cards.length === 0 ? (
          <Empty />
        ) : (
          <>
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {cards.map((card, index) => (
                <Card
                  key={card.id}
                  screenshot={card}
                  today={today}
                  onOpen={() => setOpenIndex(index)}
                />
              ))}
            </div>

          </>
        )}

        {/* Always mounted while there is more to fetch, including before the
            first page has arrived — it is what asks for that page. */}
        {hasMore && <div ref={sentinel} aria-hidden="true" className="h-px" />}

        {(hasMore || busy || error) && (
          <div className="flex flex-col items-center gap-2 border-t border-line px-3 py-3">
            {error && <p className="text-caption text-danger">{error}</p>}

            <button
              type="button"
              className="ui-btn ui-btn-secondary h-8 px-3 text-caption"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void loadMore(cursor)}
            >
              {busy ? "Loading…" : error ? "Try again" : "Load more"}
            </button>

            {!error && cards.length > 0 && (
              <p className="text-meta text-fg-4">
                {cards.length.toLocaleString()} shown so far
              </p>
            )}
          </div>
        )}
      </div>

      {open && openIndex !== null && (
        <Preview
          screenshot={open}
          today={today}
          positionLabel={`${openIndex + 1} of ${cards.length.toLocaleString()}${hasMore ? "+" : ""}`}
          onClose={() => setOpenIndex(null)}
          onPrevious={openIndex > 0 ? () => setOpenIndex(openIndex - 1) : null}
          onNext={openIndex < cards.length - 1 ? () => setOpenIndex(openIndex + 1) : null}
        />
      )}
    </section>
  );
}

/** The image URL for a card. The one place this component names an endpoint. */
function imageSrc(id: string): string {
  return `/api/performance/me/screenshots/${encodeURIComponent(id)}/image`;
}

function dedupe(cards: MyScreenshotCard[]): MyScreenshotCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
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

function sessionSpan(session: { startedAt: string; endedAt: string | null }): string {
  const started = formatClock(session.startedAt, false);
  return session.endedAt
    ? `${started} – ${formatClock(session.endedAt, false)}`
    : `${started} – now`;
}

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

/**
 * One edge chevron. Rendered even when there is nowhere to go, as a disabled
 * control, so the image does not jump at the ends of the list.
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
/* The two states that are not a grid                                         */
/* -------------------------------------------------------------------------- */

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

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Camera className="h-6 w-6 text-fg-4" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-ui font-medium text-fg">No screenshots yet</p>
      {/* No placeholder cards behind this. An empty gallery showing greyed
          rectangles reads as "loading" forever. */}
      <p className="max-w-md text-caption text-fg-3">
        Screenshots are captured by the SpiderHunts Monitor while you are signed
        in to it and on the clock. Once you have worked a shift with the Monitor
        running, they will appear here.
      </p>
    </div>
  );
}
