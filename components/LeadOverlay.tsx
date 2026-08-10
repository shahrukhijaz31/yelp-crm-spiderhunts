"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";

import LeadWorkspace from "./LeadWorkspace";
import type { LeadDetail } from "@/lib/leadDb";
import type { RecordingSummary } from "@/lib/recordingRules";
import type { Lead } from "@/lib/types";

/**
 * The lead workspace as a window within the worklist window.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * A lead used to open in a browser tab of its own. That is a clean thing to
 * build — a URL, a server component, no shared state — and a slow thing to
 * work: every lead cost a navigation out and a navigation back, and the list an
 * agent had spent time narrowing was rebuilt from the address bar each time.
 *
 * This opens the same workspace *over* the list instead. The worklist stays
 * mounted underneath with its queue tab, search, filters, sort, page and scroll
 * position untouched — not restored, untouched, because nothing unmounted — so
 * closing the window returns to the exact screen the agent left, and the loop
 * that matters (open → call → status → notes → save → next) never leaves it.
 *
 * ---------------------------------------------------------------------------
 * What it costs to open
 * ---------------------------------------------------------------------------
 *
 * One request for one lead: `GET /api/leads/:id`, the detail row and its
 * recording. The list is **not** re-fetched — the rows behind this window are
 * already the answer to that question, and asking again is the expense the
 * overlay was built to remove.
 *
 * The window is drawn before that request lands. The row that was clicked
 * already knows the business name, so the header is real from the first frame
 * and only the body below it is a skeleton; there is no spinner-then-content
 * flash, and no moment where the agent is looking at a blank rectangle
 * wondering whether the click registered.
 *
 * ---------------------------------------------------------------------------
 * Who owns leaving
 * ---------------------------------------------------------------------------
 *
 * This component does — all four ways out (Escape, the backdrop, the X, and
 * moving to another lead) go through one guard, because all four can throw away
 * a note that has been typed and not saved. `LeadWorkspace` reports whether it
 * is dirty; the guard is the browser's own confirm, which is the only thing
 * that reliably interrupts someone mid-flow.
 */

/** What one lead's window needs from the server, and nothing more. */
interface LeadOverlayData {
  detail: LeadDetail;
  recording: RecordingSummary | null;
}

export default function LeadOverlay({
  leadId,
  leadName,
  positionLabel,
  serverToday,
  onClose,
  onPrev,
  onNext,
  onSaved,
}: {
  leadId: string;
  /** Known from the row that was clicked, so the header paints immediately. */
  leadName: string;
  /** "12 of 340" within the list behind the window, when it is known. */
  positionLabel: string | null;
  serverToday: string;
  onClose: () => void;
  /** Move within the list behind the window; null at either end of it. */
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** The saved row, so the list underneath can agree with the window. */
  onSaved: (lead: Lead) => void;
}) {
  const reduced = useReducedMotion();

  const [data, setData] = useState<LeadOverlayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * The window stays mounted while an agent walks the list with Next, so a new
   * lead arrives as a changed prop rather than as a fresh component — and the
   * previous lead's detail has to go with it. Showing the last lead's notes
   * under the next lead's name for as long as a request takes is worse than
   * showing a skeleton.
   *
   * Done during render, not in an effect: this is derived state, and clearing
   * it afterwards would paint one frame of the wrong lead.
   */
  const [loadedId, setLoadedId] = useState(leadId);
  if (loadedId !== leadId) {
    setLoadedId(leadId);
    setData(null);
    setError(null);
  }

  /*
   * One lead, once per id.
   *
   * The abort is not a nicety. Holding Next walks several leads in under a
   * second, and without it the slowest response wins whichever lead is on
   * screen.
   */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/leads/${encodeURIComponent(leadId)}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(
            payload?.message ?? `The lead could not be opened (${response.status}).`,
          );
        }
        setData((await response.json()) as LeadOverlayData);
      } catch (caught) {
        if (controller.signal.aborted) return;
        console.error(`Opening lead ${leadId} failed:`, caught);
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not reach the server. The lead could not be opened.",
        );
      }
    })();

    return () => controller.abort();
  }, [leadId]);

  /** The one gate every way out of this window passes through. */
  const leave = useCallback(
    (go: () => void) => {
      if (
        dirty &&
        !window.confirm("This lead has unsaved changes. Leave without saving?")
      ) {
        return;
      }
      go();
    },
    [dirty],
  );

  // Memoised, not because building a closure is expensive but because these are
  // effect dependencies and props on a remounting child: a fresh function every
  // render would re-register the key handler on every keystroke in the notes.
  const close = useCallback(() => leave(onClose), [leave, onClose]);
  const previous = useMemo(
    () => (onPrev ? () => leave(onPrev) : null),
    [leave, onPrev],
  );
  const next = useMemo(() => (onNext ? () => leave(onNext) : null), [leave, onNext]);

  /*
   * Escape closes; Alt+arrow walks the list.
   *
   * Alt rather than the bare arrows because this window is full of fields — a
   * bare ArrowRight belongs to whichever textarea the agent is typing in, and
   * taking it would make the notes box unusable.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowRight" && next) {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft" && previous) {
        event.preventDefault();
        previous();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, next, previous]);

  /*
   * The list behind the window must not scroll while the window is open —
   * a wheel over the backdrop that moves the page underneath is exactly the
   * "which of these am I in" confusion this layout is meant to avoid. The
   * padding swap keeps the shell from shifting sideways as the scrollbar goes.
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
   * Focus moves into the window when it opens, and back to the list when it
   * closes — the row that was clicked is still there, and returning the cursor
   * to the middle of the page is how a keyboard user loses their place.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  return (
    <div
      className="lead-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Lead workspace — ${leadName}`}
    >
      {/* The backdrop dims and blurs the worklist without hiding it: the agent
          has to be able to see they are still standing on the list they came
          from. A click on it is a close, like Escape. */}
      <motion.button
        type="button"
        aria-label="Close lead workspace"
        onClick={close}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: "easeOut" }}
        className="lead-overlay-scrim"
      />

      <motion.div
        ref={panelRef}
        tabIndex={-1}
        // 8px and a hair of scale — the window arrives from the list rather
        // than flying in. Anything larger reads as a page transition, which is
        // the thing this replaced.
        initial={reduced ? false : { opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.99 }}
        transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 0.61, 0.36, 1] }}
        className="lead-overlay-panel"
      >
        {data ? (
          <LeadWorkspace
            // Remounts when the agent moves to the next lead, so a draft can
            // never arrive wearing the previous lead's edits.
            key={data.detail.lead.id}
            detail={data.detail}
            initialRecording={data.recording}
            serverToday={serverToday}
            nav={{
              variant: "overlay",
              onClose: close,
              onPrev: previous,
              onNext: next,
              positionLabel,
            }}
            onSaved={onSaved}
            onDirtyChange={setDirty}
          />
        ) : (
          <Placeholder name={leadName} error={error} onClose={onClose} />
        )}
      </motion.div>
    </div>
  );
}

/**
 * The window before its lead arrives — and, if the request fails, instead of it.
 *
 * The header is the real one: the business name came from the row, so the only
 * thing standing in for content is the body. Three blocks at the sizes the real
 * ones occupy, so nothing jumps when they are replaced.
 */
function Placeholder({
  name,
  error,
  onClose,
}: {
  name: string;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="ws-window">
      <header className="ws-identity shrink-0">
        <div className="flex items-center gap-3 px-4 pt-3 sm:px-6">
          <span className="eyebrow">Lead workspace</span>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close lead workspace"
            className="ws-window-close ml-auto"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="px-4 pb-5 pt-3 sm:px-6">
          <h1 className="text-balance text-[clamp(1.25rem,1.05rem+0.8vw,1.625rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-fg">
            {name}
          </h1>
          {!error && (
            <div className="mt-4 flex gap-2">
              <span className="skeleton block h-9 w-36 rounded-md" />
              <span className="skeleton block h-9 w-28 rounded-md" />
            </div>
          )}
        </div>
      </header>

      <div className="ws-window-scroll">
        {error ? (
          <div className="mx-auto w-full max-w-[1180px] px-4 py-16 text-center sm:px-6">
            <p role="alert" className="text-cell font-medium text-danger">
              {error}
            </p>
            <p className="mx-auto mt-2 max-w-[46ch] text-ui text-fg-3">
              The list behind this window is untouched — close it and try the
              row again.
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6">
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] xl:gap-8">
              <div className="panel divide-y divide-line overflow-hidden">
                {[0, 1, 2].map((block) => (
                  <div key={block} className="ws-block-wrap">
                    <span className="skeleton block h-3 w-24 rounded" />
                    <span className="skeleton block mt-3 block h-10 w-full rounded-md" />
                  </div>
                ))}
              </div>
              <div className="panel p-4">
                <span className="skeleton block h-3 w-20 rounded" />
                <span className="skeleton block mt-3 block h-24 w-full rounded-md" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
