"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ExternalLink, ImageOff, Mail, Phone, X } from "lucide-react";

import { demoImageSrc } from "./demoImage";
import {
  DEMO_WEBSITE_STATUS_LABELS,
  demoUrlHost,
  formatDemoDate,
  type DemoWebsiteCard,
} from "@/lib/demoWebsiteRules";
import { formatFileSize } from "@/lib/screenshotViewerRules";

/**
 * One demo website, over the list it was opened from.
 *
 * **A window rather than a page.** The same decision `LeadOverlay` and
 * `ScreenshotViewer` made, and for the same reason: the list stays mounted
 * underneath with its search, filter, sort, page and scroll position untouched
 * — not restored, untouched — so closing returns to the exact screen the reader
 * left. Somebody comparing four demos opens four of these in a row and should
 * not pay for a navigation each time.
 *
 * **What it is for.** Everything a person needs while they are showing this
 * demo to a client: the image large enough to judge, the link as a button, the
 * client and the contact details beside it, and the notes. Read-only for
 * everybody — an administrator edits from the Edit control in the list, because
 * a window that is both a viewer and a form is a window where a stray keystroke
 * is a saved change.
 *
 * Nothing here is a permission. The image points at
 * `/api/demo-websites/:id/image`, which resolves the caller from Postgres on
 * every request and refuses anyone without the Demo Websites module; this
 * component simply is never rendered for one, because the page above it refuses
 * first.
 */
export default function DemoWebsiteDialog({
  demoWebsite,
  onClose,
}: {
  demoWebsite: DemoWebsiteCard;
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);

  /** The image at full size, over the window. One more layer, one more Escape. */
  const [zoomed, setZoomed] = useState(false);

  // Escape closes the zoom first and the window second, so the two layers
  // unwind in the order they were opened rather than both at once.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (zoomed) setZoomed(false);
      else onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, zoomed]);

  // The list behind the window must not scroll while it is open. The padding
  // swap keeps the shell from shifting sideways as the scrollbar goes.
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

  // Focus moves into the window when it opens, so the keyboard is inside it and
  // Escape lands here rather than on whatever was focused in the list.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const image = demoWebsite.image;

  return (
    <div className="lead-overlay" role="presentation">
      <button
        type="button"
        aria-label="Close demo website"
        onClick={onClose}
        className="lead-overlay-scrim"
      />

      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${demoWebsite.name} — demo website`}
        tabIndex={-1}
        initial={reduced ? false : { opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduced ? 0 : 0.18, ease: [0.2, 0.7, 0.3, 1] }}
        className="lead-overlay-panel ws-window outline-none"
      >
        {/* --- header ----------------------------------------------------- */}
        <header className="flex items-start gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Demo website</p>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-[-0.01em] text-fg">
              {demoWebsite.name}
            </h2>
            <p className="mt-1 truncate text-ui text-fg-3">
              {demoWebsite.clientName || "No client recorded"}
            </p>
          </div>

          <StatusChip status={demoWebsite.status} />

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ws-window-close shrink-0"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        {/* --- body ------------------------------------------------------- */}
        <div className="ws-window-scroll flex flex-col gap-5 px-5 py-5">
          {/* The image, first and largest: it is what a demo website *is*. */}
          <section>
            {image ? (
              <button
                type="button"
                onClick={() => setZoomed(true)}
                aria-label={`View ${demoWebsite.name} at full size`}
                className="group block w-full overflow-hidden rounded-lg border border-line bg-recessed outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
              >
                {/* A plain <img> rather than next/image: these bytes come from
                    an authenticated route, so the optimiser could not fetch
                    them, and the browser's own request is the one carrying the
                    session cookie. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={demoImageSrc(demoWebsite)}
                  alt={`Demo image for ${demoWebsite.name}`}
                  width={image.width}
                  height={image.height}
                  className="h-auto w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
                />
              </button>
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-2 bg-recessed px-6 py-10 text-fg-4">
                <ImageOff className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                <p className="text-caption">No demo image has been uploaded.</p>
              </div>
            )}
            {image && (
              <p className="mt-2 text-meta text-fg-4">
                <span className="tnum font-mono">
                  {image.width}×{image.height}
                </span>{" "}
                · {formatFileSize(image.fileSize)} · click to enlarge
              </p>
            )}
          </section>

          {/* The link, as the one filled button on the screen: it is the action
              this record exists for. */}
          <section className="panel-inset flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="field-label">Demo link</p>
              <p className="mt-1 truncate font-mono text-caption text-fg-2">
                {demoWebsite.demoUrl}
              </p>
            </div>
            <OpenDemoButton url={demoWebsite.demoUrl} />
          </section>

          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Detail label="Client / company" value={demoWebsite.clientName || "—"} />
            <Detail label="Status" value={DEMO_WEBSITE_STATUS_LABELS[demoWebsite.status]} />
            <Detail
              label="Phone"
              value={demoWebsite.phone ?? "—"}
              icon={demoWebsite.phone ? Phone : undefined}
              href={demoWebsite.phone ? `tel:${demoWebsite.phone}` : undefined}
            />
            <Detail
              label="Email"
              value={demoWebsite.email ?? "—"}
              icon={demoWebsite.email ? Mail : undefined}
              href={demoWebsite.email ? `mailto:${demoWebsite.email}` : undefined}
            />
            <Detail label="Created" value={formatDemoDate(demoWebsite.createdAt)} />
            <Detail label="Last updated" value={formatDemoDate(demoWebsite.updatedAt)} />
          </dl>

          <section>
            <p className="field-label">Notes</p>
            {/* `whitespace-pre-wrap` so line breaks an administrator typed
                survive, and nothing else about the text is interpreted — this
                is rendered as text by React, never as markup. */}
            <p className="mt-1.5 whitespace-pre-wrap text-ui text-fg-2">
              {demoWebsite.notes.trim() || <span className="text-fg-4">No notes.</span>}
            </p>
          </section>
        </div>
      </motion.div>

      {/* --- the image at full size -------------------------------------- */}
      {zoomed && image && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8">
          <button
            type="button"
            aria-label="Close full-size image"
            onClick={() => setZoomed(false)}
            className="absolute inset-0 cursor-zoom-out bg-base/85 backdrop-blur-sm"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={demoImageSrc(demoWebsite)}
            alt={`Demo image for ${demoWebsite.name}, full size`}
            className="pop-in relative max-h-full max-w-full rounded-lg border border-line object-contain shadow-e3"
          />
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close full-size image"
            className="ui-btn ui-btn-secondary absolute right-4 top-4 h-8 w-8 !px-0"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Open Demo.
 *
 * `target="_blank"` because the whole point is to leave the portal without
 * losing the list, and `rel="noopener noreferrer"` because a page opened this
 * way can otherwise reach back through `window.opener`. The href is a URL that
 * was validated to be http or https before it was stored
 * (`normaliseDemoUrl`), so there is no `javascript:` for this anchor to run.
 */
export function OpenDemoButton({
  url,
  className = "",
}: {
  url: string;
  className?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${demoUrlHost(url)} in a new tab`}
      className={`ui-btn ui-btn-primary shrink-0 ${className}`}
    >
      <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      Open Demo
    </a>
  );
}

export function StatusChip({ status }: { status: DemoWebsiteCard["status"] }) {
  // Whole literal class strings per status rather than an interpolated token
  // name: Tailwind scans source text, and a class it cannot see written out is
  // a class it does not build.
  const tone: Record<DemoWebsiteCard["status"], string> = {
    draft: "border-line-2 bg-st-steel-bg text-st-steel",
    active: "border-success-line bg-success-bg text-success",
    presented: "border-accent-line bg-accent-soft text-accent",
    archived: "border-line-2 text-fg-4",
  };

  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider ${tone[status]}`}
    >
      {DEMO_WEBSITE_STATUS_LABELS[status]}
    </span>
  );
}

function Detail({
  label,
  value,
  icon: Icon,
  href,
}: {
  label: string;
  value: string;
  icon?: typeof Phone;
  href?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="field-label">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1.5 text-ui text-fg-2">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />}
        {href ? (
          <a href={href} className="truncate hover:text-accent hover:underline">
            {value}
          </a>
        ) : (
          <span className="truncate">{value}</span>
        )}
      </dd>
    </div>
  );
}
