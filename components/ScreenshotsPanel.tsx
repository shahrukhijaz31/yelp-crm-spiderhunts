"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  Clock3,
  ImageOff,
  Monitor,
  Users2,
} from "lucide-react";

import CountUp from "./CountUp";
import Pagination from "./Pagination";
import ScreenshotViewer from "./ScreenshotViewer";
import { useSpotlight } from "./useSpotlight";
import type { Role } from "@/lib/access";
import {
  buildScreenshotSearchParams,
  DATE_PRESETS,
  DATE_PRESET_LABELS,
  defaultScreenshotQuery,
  formatClock,
  formatDayLabel,
  formatTimeOfDay,
  formatWorkSessionSpan,
  parseTimeOfDay,
  screenshotWindow,
  SCREENSHOT_PAGE_SIZES,
  type DatePreset,
  type ScreenshotCard,
  type ScreenshotPayload,
  type ScreenshotQuery,
  type TimelinePoint,
  type WorkSessionSummary,
} from "@/lib/screenshotViewerRules";

/**
 * Screenshots — the administrator's monitoring screen.
 *
 * ---------------------------------------------------------------------------
 * The security note first, because it is the important one
 * ---------------------------------------------------------------------------
 * Everything here arrives from `GET /api/screenshots`, and every image from
 * `GET /api/screenshots/:id/image`. Both are behind `apiAdmin()`, which resolves
 * the caller from the session row in Postgres and answers 403 to an agent
 * holding a perfectly valid session. Nothing in this file — not the agent
 * picker, not the initial render, not the fact that the nav item is hidden — is
 * what keeps an agent out. If every line of it were pasted into an agent's
 * browser it would fetch nothing but refusals.
 *
 * ---------------------------------------------------------------------------
 * What the screen is
 * ---------------------------------------------------------------------------
 * Four figures, a filter bar, a timeline, a grid, a pager. In that order,
 * because that is the order the question is asked in: how much is there, of
 * what, when did it happen, and then — only then — the pictures.
 *
 * The gallery is the point, so it is given the room. The chrome above it is
 * one panel of dense controls rather than a row of cards, and the metrics are
 * divided segments of a single strip rather than four bordered tiles, which is
 * the object the rest of the portal already uses for a summary of one thing
 * over one window.
 *
 * ---------------------------------------------------------------------------
 * One fetch per filter, and never the whole table
 * ---------------------------------------------------------------------------
 * Changing anything in the bar re-queries the server. Nothing is filtered in
 * the browser, because the browser never holds more than a page — 50 cards by
 * default, out of a table that grows by several rows per agent per hour, all
 * day, forever. The timeline is the one unpaged read and it is capped and
 * carries only three small columns per point.
 *
 * ---------------------------------------------------------------------------
 * Why plain `<img>` and no thumbnails
 * ---------------------------------------------------------------------------
 * `next/image` cannot serve these. Its optimiser fetches the source URL itself,
 * server-side and without the browser's session cookie, so it would meet the
 * same 401 an anonymous request meets — which is exactly the property that
 * makes these images safe. A screenshot is an authenticated byte stream, not a
 * static asset.
 *
 * That leaves the grid showing full-resolution JPEGs at card size, which is
 * handled rather than ignored: `loading="lazy"` means only what is scrolled
 * past is ever requested, the cards are a fixed aspect ratio so nothing
 * reflows as images arrive, and each one fades in over its own skeleton. A real
 * thumbnail pipeline would need an image-processing dependency and a second
 * artefact per screenshot to store, expire and keep consistent with the
 * original — a large amount of machinery for a screen a handful of
 * administrators open, and deliberately not built at this stage.
 */

interface AgentOption {
  id: string;
  name: string;
  role: Role;
}

export default function ScreenshotsPanel({
  initialPayload,
  serverToday,
  agents,
}: {
  initialPayload: ScreenshotPayload;
  serverToday: string;
  /** Every account, for the picker. Names only — this is a filter, not a list. */
  agents: AgentOption[];
}) {
  const [query, setQuery] = useState<ScreenshotQuery>(() =>
    defaultScreenshotQuery(serverToday),
  );
  const [payload, setPayload] = useState(initialPayload);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Index into the current page, or null when the window is closed. */
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // Identifies the request in flight, so a slow "yesterday" cannot land on top
  // of the "today" an administrator asked for afterwards. The same guard the
  // worklist and the team report use, for the same reason.
  const requestId = useRef(0);

  const load = useCallback(async (next: ScreenshotQuery) => {
    const id = (requestId.current += 1);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/screenshots?${buildScreenshotSearchParams(next)}`, {
        credentials: "same-origin",
      });
      if (id !== requestId.current) return;

      if (!response.ok) {
        setError(
          response.status === 403
            ? "Screenshots are for administrators only."
            : response.status === 401
              ? "Your session has ended. Sign in again to continue."
              : "Could not load screenshots. Try again.",
        );
        return;
      }

      const body = (await response.json()) as ScreenshotPayload;
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
  // screen that was already correct.
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
   * Every edit except paging returns to page one. Landing on page 7 of a filter
   * that now has two pages is a blank screen that looks like "no screenshots"
   * and is not — the one empty state that would be a lie.
   */
  const amend = useCallback((edits: Partial<ScreenshotQuery>) => {
    setOpenIndex(null);
    setQuery((current) => ({
      ...current,
      ...edits,
      page: edits.page ?? 1,
    }));
  }, []);

  const { screenshots, meta, summary, timeline, timelineTruncated, sessions } = payload;

  const selectedAgent = query.userId
    ? (agents.find((agent) => agent.id === query.userId) ?? null)
    : null;

  // Named for what it is rather than `window`, which is already taken by
  // something the browser is quite attached to.
  const viewWindow = useMemo(() => screenshotWindow(query), [query]);

  /** True when the view is the plain default: today, all day. */
  const isWholeToday =
    query.preset === "today" && query.fromMinutes === null && query.toMinutes === null;

  const open = openIndex === null ? null : (screenshots[openIndex] ?? null);

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">Screenshots</h1>
          <p className="mt-2 page-intro">
            What agent workstations were showing, captured by the SpiderHunts
            Monitor during a work session. Every image here was taken while
            somebody was on the clock — nothing is sampled, filled in or
            reconstructed.
          </p>
        </div>
      </header>

      {/* --- the four figures --------------------------------------------- */}
      <section
        aria-label="Screenshot totals"
        className={`panel grid grid-cols-1 gap-px overflow-hidden bg-line transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-4 ${
          busy ? "opacity-60" : ""
        }`}
      >
        <Metric
          icon={Monitor}
          value={summary.inWindow}
          label={isWholeToday ? "Screenshots today" : "Screenshots in view"}
          hint={windowCaption(query)}
        />
        <Metric
          icon={Users2}
          value={summary.activeAgents}
          label="Active agents"
          hint="with a capture in this window"
        />
        <Metric
          icon={Clock3}
          text={summary.latestCaptureAt ? formatClock(summary.latestCaptureAt) : "—"}
          label="Latest capture"
          hint={summary.latestCaptureAt ? "most recent in this window" : "nothing captured yet"}
        />
        <Metric
          icon={CalendarClock}
          text={selectedAgent ? selectedAgent.name : "All agents"}
          label="Selected agent"
          hint={
            selectedAgent
              ? selectedAgent.role === "ADMIN"
                ? "administrator"
                : "agent"
              : `${agents.length} account${agents.length === 1 ? "" : "s"} in the portal`
          }
        />
      </section>

      {/* --- filters ------------------------------------------------------ */}
      <section
        aria-label="Screenshot filters"
        className="panel flex flex-wrap items-end gap-3 px-4 py-3"
      >
        <Field label="Date" htmlFor="date">
          <Select
            id="date"
            value={query.preset}
            onChange={(value) => amend({ preset: value as DatePreset, day: dayFor(value as DatePreset, query.day, serverToday) })}
            options={DATE_PRESETS.map((preset) => ({
              value: preset,
              label: DATE_PRESET_LABELS[preset],
            }))}
          />
        </Field>

        {query.preset === "custom" && (
          <Field label="Day" htmlFor="day">
            <input
              id="day"
              type="date"
              value={query.day}
              max={serverToday}
              onChange={(event) => amend({ day: event.target.value })}
              className="ui-field h-9 w-[152px]"
            />
          </Field>
        )}

        <Field label="Agent" htmlFor="agent">
          <Select
            id="agent"
            value={query.userId ?? "all"}
            // Changing the agent clears the shift: a work session belongs to
            // one person, so keeping the old selection would filter to a shift
            // the newly chosen agent never worked and show nothing.
            onChange={(value) =>
              amend({ userId: value === "all" ? null : value, workSessionId: null })
            }
            options={[
              { value: "all", label: "All agents" },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.role === "ADMIN" ? `${agent.name} (admin)` : agent.name,
              })),
            ]}
          />
        </Field>

        <Field label="Work session" htmlFor="session">
          <Select
            id="session"
            value={query.workSessionId ?? "all"}
            onChange={(value) => amend({ workSessionId: value === "all" ? null : value })}
            options={[
              { value: "all", label: "All sessions" },
              ...sessions.map((session) => ({
                value: session.id,
                label: sessionLabel(session),
              })),
            ]}
            disabled={sessions.length === 0}
          />
        </Field>

        <Field label="From" htmlFor="from">
          <input
            id="from"
            type="time"
            value={formatTimeOfDay(query.fromMinutes)}
            onChange={(event) => amend({ fromMinutes: parseTimeOfDay(event.target.value) })}
            className="ui-field h-9 w-[112px]"
          />
        </Field>

        <Field label="To" htmlFor="to">
          <input
            id="to"
            type="time"
            value={formatTimeOfDay(query.toMinutes)}
            onChange={(event) => amend({ toMinutes: parseTimeOfDay(event.target.value) })}
            className="ui-field h-9 w-[112px]"
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
      </section>

      {/* --- timeline ------------------------------------------------------ */}
      <Timeline
        points={timeline}
        truncated={timelineTruncated}
        from={viewWindow.from}
        to={viewWindow.to}
        busy={busy}
      />

      {/* --- the gallery ---------------------------------------------------- */}
      <section className="panel overflow-hidden">
        {error ? (
          <Empty
            icon={ImageOff}
            title={
              error.startsWith("Screenshots are for")
                ? "You do not have access to this"
                : "Screenshots could not be loaded"
            }
            body={error}
          />
        ) : busy && screenshots.length === 0 ? (
          <SkeletonGrid count={query.pageSize > 25 ? 12 : 8} />
        ) : screenshots.length === 0 ? (
          <Empty
            icon={Monitor}
            title="No screenshots found"
            body={emptyReason(query, selectedAgent)}
          />
        ) : (
          <div
            className={`grid gap-3 p-3 transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 ${
              busy ? "opacity-60" : ""
            }`}
          >
            {screenshots.map((screenshot, index) => (
              <Card
                key={screenshot.id}
                screenshot={screenshot}
                serverToday={serverToday}
                showAgent={query.userId === null}
                onOpen={() => setOpenIndex(index)}
              />
            ))}
          </div>
        )}

        {/* The pager stays under an empty grid: it is what says "page 3 of 1",
            which is the fastest way to understand an empty screen that is empty
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
          onPageSizeChange={(pageSize) => amend({ pageSize })}
          pageSizes={SCREENSHOT_PAGE_SIZES}
          noun="screenshots"
          emptyLabel="No screenshots match the current filters"
          label="Screenshot pages"
        />
      </section>

      {open && openIndex !== null && (
        <ScreenshotViewer
          screenshot={open}
          serverToday={serverToday}
          positionLabel={`${(meta.page - 1) * meta.pageSize + openIndex + 1} of ${meta.total.toLocaleString()}`}
          onClose={() => setOpenIndex(null)}
          onPrevious={openIndex > 0 ? () => setOpenIndex(openIndex - 1) : null}
          onNext={
            openIndex < screenshots.length - 1 ? () => setOpenIndex(openIndex + 1) : null
          }
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One card                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A screenshot, its agent and when it was taken.
 *
 * The preview is a fixed 16:10 rectangle — near enough to the aspect ratio of
 * every desktop this will ever show that `object-cover` crops almost nothing,
 * and fixed so that a grid of forty cards is laid out before a single image has
 * arrived and never reflows as they do.
 *
 * Its load state is local to the card. Lifting it into the panel would re-render
 * the whole grid once per image as fifty of them arrive out of order.
 */
function Card({
  screenshot,
  serverToday,
  showAgent,
  onOpen,
}: {
  screenshot: ScreenshotCard;
  serverToday: string;
  /** Hidden when the grid is already filtered to one person. */
  showAgent: boolean;
  onOpen: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition-all duration-200 hover:border-line-2 hover:shadow-[var(--c-shadow-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
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
           * `loading="lazy"` is what makes a page of fifty affordable: only the
           * cards that are scrolled to are ever requested, so opening the
           * screen costs the two rows that are visible.
           *
           * See the note at the top of this file for why this is a plain `img`
           * and not `next/image`.
           */
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated byte stream, not an optimisable static asset.
          <img
            src={`/api/screenshots/${encodeURIComponent(screenshot.id)}/image`}
            alt={`Screenshot of ${screenshot.agent.name}'s desktop at ${formatClock(screenshot.capturedAt)}`}
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
        {showAgent && (
          <p className="truncate text-caption font-medium text-fg">
            {screenshot.agent.name}
          </p>
        )}
        <p className="tnum flex items-center gap-1.5 font-mono text-meta text-fg-2">
          <span>{formatDayLabel(screenshot.capturedAt, serverToday)}</span>
          <span aria-hidden="true" className="text-fg-4">·</span>
          <span>{formatClock(screenshot.capturedAt)}</span>
        </p>
        <p className="tnum flex items-center gap-1.5 font-mono text-meta text-fg-4">
          <span>
            {screenshot.width} × {screenshot.height}
          </span>
          {screenshot.workSession && (
            <>
              <span aria-hidden="true">·</span>
              {/* The shift indicator: a dot that is filled while the session is
                  still open. Not a badge — it is a fact about the capture, not
                  a status anybody needs to act on. */}
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  screenshot.workSession.endedAt ? "bg-fg-4/60" : "bg-success"
                }`}
              />
              <span className="truncate">
                {formatWorkSessionSpan(screenshot.workSession)}
              </span>
            </>
          )}
        </p>
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* The timeline strip                                                         */
/* -------------------------------------------------------------------------- */

/**
 * When, during the window, the captures actually happened.
 *
 * **Only real rows are drawn.** There is one dot per screenshot in the window
 * and nothing else on the strip — no interpolation between them, no marker for
 * a gap, no "expected" capture that did not arrive. A monitoring timeline that
 * invented a point would be worse than no timeline at all, because it would be
 * believed.
 *
 * The axis tightens to the data when no time filter is set: a full 24-hour ruler
 * with every dot bunched between nine and five wastes two thirds of its width on
 * hours nobody worked. It is still derived from the captures themselves — the
 * hour below the first and the hour above the last — so it never claims a range
 * that no record supports. With a time filter it is exactly the filter, because
 * then the empty parts are the answer to a question that was asked.
 */
function Timeline({
  points,
  truncated,
  from,
  to,
  busy,
}: {
  points: TimelinePoint[];
  truncated: boolean;
  from: Date;
  to: Date;
  busy: boolean;
}) {
  const axis = useMemo(() => buildAxis(points, from, to), [points, from, to]);

  return (
    <section
      aria-label="Capture timeline"
      className={`panel px-4 pb-3 pt-2.5 transition-opacity duration-200 ${busy ? "opacity-60" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Capture timeline</p>
        <p className="tnum font-mono text-meta text-fg-4">
          {points.length.toLocaleString()}
          {truncated ? "+" : ""} capture{points.length === 1 && !truncated ? "" : "s"}
        </p>
      </div>

      {points.length === 0 ? (
        <p className="mt-3 text-caption text-fg-4">
          Nothing was captured in this window.
        </p>
      ) : (
        <div className="mt-2.5">
          {/* The ruler: hairline, tick marks, labels. */}
          <div className="relative h-9">
            <div
              aria-hidden="true"
              className="absolute inset-x-0 bottom-3 h-px bg-line-2"
            />

            {axis.ticks.map((tick) => (
              <div
                key={tick.at}
                aria-hidden="true"
                className="absolute bottom-3 flex -translate-x-1/2 flex-col items-center"
                style={{ left: `${tick.percent}%` }}
              >
                <span className="tnum mb-1 font-mono text-meta text-fg-4">
                  {tick.label}
                </span>
                <span className="h-1.5 w-px bg-line-2" />
              </div>
            ))}

            {/* The dots. Absolutely positioned on the same line as the ruler,
                slightly transparent so a cluster reads as a denser mark rather
                than as one dot — which is the honest way to draw four captures
                a minute apart at this scale. */}
            {points.map((point) => (
              <span
                key={point.id}
                title={formatClock(point.capturedAt)}
                className="absolute bottom-3 h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-accent/70 ring-1 ring-[var(--c-surface)]"
                style={{ left: `${percentOf(point.capturedAt, axis.from, axis.to)}%` }}
              />
            ))}
          </div>

          {truncated && (
            <p className="mt-1 text-meta text-fg-4">
              Showing the first {points.length.toLocaleString()} captures of this
              window. Narrow the filters to see the rest.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

interface Axis {
  from: number;
  to: number;
  ticks: Array<{ at: number; percent: number; label: string }>;
}

const HOUR_MS = 3_600_000;

/** Where an instant sits across the axis, clamped to it. */
function percentOf(iso: string, from: number, to: number): number {
  const at = new Date(iso).getTime();
  const span = Math.max(1, to - from);
  return Math.min(100, Math.max(0, ((at - from) / span) * 100));
}

/**
 * The ruler under the dots.
 *
 * The step is the smallest of 1, 2, 3, 4, 6 or 12 hours that keeps the labels
 * under about seven — more than that and they collide on a laptop, fewer and
 * the strip stops being readable as a clock.
 */
function buildAxis(points: TimelinePoint[], windowFrom: Date, windowTo: Date): Axis {
  let from = windowFrom.getTime();
  let to = windowTo.getTime();

  // A whole untouched day tightens to the captures; anything the administrator
  // asked for explicitly is shown exactly as asked.
  const isWholeDay = to - from >= 24 * HOUR_MS;
  if (isWholeDay && points.length > 0) {
    const times = points.map((point) => new Date(point.capturedAt).getTime());
    const first = Math.min(...times);
    const last = Math.max(...times);

    from = Math.floor(first / HOUR_MS) * HOUR_MS;
    to = Math.ceil(last / HOUR_MS) * HOUR_MS;
    // A single capture would otherwise be a zero-width axis.
    if (to - from < 2 * HOUR_MS) to = from + 2 * HOUR_MS;
  }

  const spanHours = (to - from) / HOUR_MS;
  const step = [1, 2, 3, 4, 6, 12].find((candidate) => spanHours / candidate <= 7) ?? 24;

  const ticks: Axis["ticks"] = [];
  const first = Math.ceil(from / (step * HOUR_MS)) * step * HOUR_MS;
  for (let at = first; at <= to; at += step * HOUR_MS) {
    ticks.push({
      at,
      percent: ((at - from) / Math.max(1, to - from)) * 100,
      label: new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    });
  }

  return { from, to, ticks };
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div
      className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
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

function Empty({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Monitor;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Icon className="h-6 w-6 text-fg-4" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-ui font-medium text-fg">{title}</p>
      {/* No placeholder cards behind this. An empty gallery showing greyed
          rectangles reads as "loading" forever, and showing invented pictures
          would be worse than either. */}
      <p className="max-w-md text-caption text-fg-3">{body}</p>
    </div>
  );
}

/** Why this screen is empty, said as specifically as the filters allow. */
function emptyReason(query: ScreenshotQuery, agent: AgentOption | null): string {
  const when =
    query.preset === "today"
      ? "today"
      : query.preset === "yesterday"
        ? "yesterday"
        : `on ${query.day}`;

  const span =
    query.fromMinutes !== null || query.toMinutes !== null
      ? ` between ${formatTimeOfDay(query.fromMinutes) || "00:00"} and ${formatTimeOfDay(query.toMinutes) || "24:00"}`
      : "";

  if (query.workSessionId) {
    return `No screenshots were captured during the selected work session${span}.`;
  }

  if (agent) {
    return `No screenshots were captured for ${agent.name} ${when}${span}.`;
  }

  return `No screenshots were captured by any agent ${when}${span}. Screenshots are only taken while an agent is signed in to the Monitor and on the clock.`;
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

function Metric({
  icon: Icon,
  value,
  text,
  label,
  hint,
}: {
  icon: typeof Monitor;
  value?: number;
  text?: string;
  label: string;
  hint: string;
}) {
  const spotlight = useSpotlight<HTMLDivElement>();

  return (
    <div {...spotlight} className="spotlight group relative isolate bg-surface px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption font-medium text-fg-3">{label}</p>
          <p className="display-num mt-1.5 truncate text-[28px] leading-none text-fg">
            {text ?? <CountUp value={value ?? 0} />}
          </p>
          <p className="mt-1.5 truncate text-meta text-fg-4">{hint}</p>
        </div>
        <Icon
          className="h-4 w-4 shrink-0 text-fg-4 transition-transform duration-300 group-hover:-translate-y-0.5"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
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
 * A native `<select>`, styled — the same one the team report uses, and not a
 * custom listbox for the same reason: the platform control is better than
 * anything that would be built here and comes with keyboard and screen-reader
 * behaviour for free.
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

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/** Which day a preset means, when the picker is switched. */
function dayFor(preset: DatePreset, currentDay: string, today: string): string {
  if (preset === "today") return today;
  if (preset === "custom") return currentDay;
  // "Yesterday" is resolved on the server from its own clock; this is only what
  // the date input shows until the response lands.
  const date = new Date(`${today}T00:00:00`);
  date.setDate(date.getDate() - 1);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

/** "Today · all day" / "2026-08-12 · 09:00–17:00" — what the figures cover. */
function windowCaption(query: ScreenshotQuery): string {
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

/**
 * A shift in the picker: its span, and how many captures fall inside it.
 *
 * The count is what makes the list usable — three shifts on one day are told
 * apart far faster by "34 shots" than by two timestamps that differ by minutes.
 * It is a real count from the database, never an estimate, and it counts the
 * whole shift rather than the current filter, which is why a session can read
 * "34 shots" while the grid under a narrow time filter shows four.
 */
function sessionLabel(session: WorkSessionSummary): string {
  const span = formatWorkSessionSpan(session);
  const count = session.screenshotCount;
  return count === undefined ? span : `${span} · ${count} shot${count === 1 ? "" : "s"}`;
}
