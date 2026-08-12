"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, ImageOff, Monitor, X } from "lucide-react";

import {
  formatClock,
  formatDayLabel,
  formatFileSize,
  formatWorkSessionSpan,
  type ScreenshotCard,
} from "@/lib/screenshotViewerRules";

/**
 * One screenshot, large, over the gallery it was opened from.
 *
 * **A window rather than a tab.** The same decision `LeadOverlay` made and for
 * the same reason: an administrator reviewing a shift opens a dozen of these in
 * a row, and a navigation out and back each time would rebuild the filter,
 * the page and the scroll position they had carefully arrived at. The grid
 * stays mounted underneath, untouched — not restored, untouched — so closing
 * returns to the exact screen they left.
 *
 * **The image is the interface.** Everything else is one strip of metadata
 * along the bottom and two chevrons at the edges; there is no toolbar, no
 * sidebar of properties and no chrome around the picture. A screenshot is read
 * by looking at it, and every pixel spent on decoration is a pixel taken from
 * the thing being reviewed.
 *
 * **This is where full resolution is paid for.** The gallery deliberately shows
 * the same bytes at thumbnail size behind `loading="lazy"`, so a page of fifty
 * costs only what is scrolled past. Here one image is fetched at its real size,
 * which is what the administrator opened it to see.
 *
 * Nothing here is a permission. The `<img>` points at
 * `/api/screenshots/:id/image`, which resolves the caller's role from Postgres
 * on every request and answers 403 to an agent — this component simply is never
 * rendered for one, because the page above it refuses first.
 */
export default function ScreenshotViewer({
  screenshot,
  /** "12 of 340" within the page behind the window. */
  positionLabel,
  serverToday,
  onClose,
  onPrevious,
  onNext,
}: {
  screenshot: ScreenshotCard;
  positionLabel: string | null;
  serverToday: string;
  onClose: () => void;
  /** Null at either end of the current page. */
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * The image's own state, reset when the window is walked to another capture.
   *
   * Done during render rather than in an effect: this is derived from the id,
   * and clearing it afterwards would paint one frame of the previous screenshot
   * under the next one's caption.
   */
  const [shownId, setShownId] = useState(screenshot.id);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  if (shownId !== screenshot.id) {
    setShownId(screenshot.id);
    setStatus("loading");
  }

  /*
   * Escape closes, bare arrows walk the page.
   *
   * Bare rather than `Alt`+arrow, which is what `LeadOverlay` needs — that
   * window is full of text fields where ArrowRight belongs to whichever
   * textarea has focus. There is nothing to type into here, so the unmodified
   * keys are free and are what anyone who has used an image viewer will reach
   * for. Modified presses are left alone so browser shortcuts still work.
   */
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

  /*
   * The gallery behind the window must not scroll while it is open — a wheel
   * over the backdrop that moves the grid underneath is exactly the "which of
   * these am I in" confusion a window is meant to avoid. The padding swap keeps
   * the shell from shifting sideways as the scrollbar goes.
   */
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

  /*
   * Focus moves into the window when it opens and back to the card when it
   * closes. The card that was clicked is still there, and returning the cursor
   * to the top of the document is how a keyboard user loses their place.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const capturedDay = formatDayLabel(screenshot.capturedAt, serverToday);

  return (
    <div
      className="lead-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Screenshot from ${screenshot.agent.name}, ${capturedDay} at ${formatClock(screenshot.capturedAt)}`}
    >
      {/* Dims and blurs the gallery without hiding it: the administrator has to
          be able to see they are still standing on the day they came from. A
          click on it closes, like Escape. */}
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
        {/* --- header ---------------------------------------------------- */}
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
          <Monitor className="h-4 w-4 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="truncate text-ui font-semibold tracking-[-0.01em] text-fg">
              {screenshot.agent.name}
            </p>
            <p className="tnum shrink-0 font-mono text-caption text-fg-3">
              {capturedDay} · {formatClock(screenshot.capturedAt)}
            </p>
          </div>

          {positionLabel && (
            <p className="tnum ml-auto shrink-0 font-mono text-meta text-fg-4 max-sm:hidden">
              {positionLabel}
            </p>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`ws-window-close ${positionLabel ? "" : "ml-auto"}`}
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        {/* --- the screenshot -------------------------------------------- */}
        {/* `bg-base` rather than the panel surface: a screenshot is usually a
            bright desktop, and a darker floor behind it is what stops the
            letterboxing from reading as part of the image. */}
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
                The screenshot record exists, but its image file could not be read
                from storage. It may have been removed by the retention sweep.
              </p>
            </div>
          ) : (
            /*
             * `object-contain`, unlike the grid's `cover`. A card is a fixed
             * rectangle showing what a desktop looked like, so cropping it is
             * fine; this is the review itself, and a crop here would hide the
             * part of the screen somebody opened it to read.
             *
             * Keyed by id so React replaces the element rather than reusing it
             * when the window is walked — a reused `<img>` keeps showing the
             * previous picture until the new one decodes.
             */
            // eslint-disable-next-line @next/next/no-img-element -- an authenticated byte stream, not an optimisable static asset: see the note in ScreenshotsPanel.
            <img
              key={screenshot.id}
              src={`/api/screenshots/${encodeURIComponent(screenshot.id)}/image`}
              alt={`Screenshot of ${screenshot.agent.name}'s desktop, captured at ${formatClock(screenshot.capturedAt)}`}
              width={screenshot.width}
              height={screenshot.height}
              onLoad={() => setStatus("ready")}
              onError={() => setStatus("failed")}
              className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${
                status === "ready" ? "opacity-100" : "opacity-0"
              }`}
            />
          )}

          {/* Edge chevrons rather than a button bar: they sit where the eye
              already is when it reaches the end of an image, and they leave the
              picture uncovered in the middle where it is being read. */}
          <StepButton side="left" onClick={onPrevious} />
          <StepButton side="right" onClick={onNext} />
        </div>

        {/* --- the facts -------------------------------------------------- */}
        <div className="ws-window-foot justify-between gap-x-6">
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
            <Fact label="Agent" value={screenshot.agent.name} />
            <Fact label="Captured" value={`${capturedDay} · ${formatClock(screenshot.capturedAt)}`} mono />
            <Fact
              label="Work session"
              value={
                screenshot.workSession
                  ? `${formatDayLabel(screenshot.workSession.startedAt, serverToday)} · ${formatWorkSessionSpan(screenshot.workSession)}`
                  : // Never invented. A screenshot with no shift is a row this
                    // schema does not currently allow, and saying so is the
                    // only honest thing to show if one ever appears.
                    "Unavailable"
              }
              mono={screenshot.workSession !== null}
            />
            <Fact label="Resolution" value={`${screenshot.width} × ${screenshot.height}`} mono />
            <Fact label="Size" value={formatFileSize(screenshot.fileSize)} mono />
          </dl>

          <p className="text-meta text-fg-4 max-lg:hidden">
            <kbd className="font-mono">←</kbd> <kbd className="font-mono">→</kbd> to
            move · <kbd className="font-mono">Esc</kbd> to close
          </p>
        </div>
      </motion.div>
    </div>
  );
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
      <dd
        className={`mt-0.5 truncate text-caption text-fg-2 ${mono ? "tnum font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * One edge chevron.
 *
 * Rendered even when there is nowhere to go, as a disabled control, so the two
 * sides of the image do not change width at the ends of a page — a button that
 * vanishes takes the layout with it and makes the picture jump.
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
