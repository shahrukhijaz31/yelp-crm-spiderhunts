"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarCheck2,
  CalendarClock,
  CalendarPlus,
  Check,
  Globe,
  MapPin,
  Phone,
  PhoneOff,
  RotateCcw,
  Star,
} from "lucide-react";

import BookMeetingDialog from "./BookMeetingDialog";
import CallRecordingPanel from "./CallRecordingPanel";
import LeadActivity from "./LeadActivity";
import StatusPicker from "./StatusPicker";
import { StatusChip } from "./StatusSelect";
import { callbackState, displayWebsite, websiteHref } from "@/lib/leadUtils";
import { formatMeetingDay, formatMeetingTime, isMeetingLead } from "@/lib/meetings";
import type { LeadDetail } from "@/lib/leadDb";
import type { RecordingSummary } from "@/lib/recordingRules";
import { CALL_STATUS_LABELS, type Lead, type LeadEditableFields } from "@/lib/types";
import { whatsappLink } from "@/lib/whatsapp";

/**
 * The lead workspace: one lead, in its own browser tab, with everything needed
 * to work it and nothing else.
 *
 * ---------------------------------------------------------------------------
 * What this screen is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * It is not the row's editing columns moved onto a page. The worklist is now a
 * *discovery* surface — who is on the list, what do they do, where are they —
 * and this is the *working* surface, which is a different job with a different
 * shape:
 *
 *   identity     who am I about to ring, and can I dial them from here
 *   reference    the scraped facts, laid out to be read rather than scanned
 *   work         status, meeting, notes, recording — the four things a call
 *                produces, in the order a call produces them
 *   record       what is already known to have happened
 *
 * The four are separated by *layer* rather than by four bordered cards: the
 * page is a ground, the header floats over it, the identity band is lit from
 * behind, and only the working column sits on a raised surface. A page of
 * equal-weight rounded rectangles has no hierarchy at all, which is exactly
 * what makes a CRM look like a database front end.
 *
 * ---------------------------------------------------------------------------
 * State, and the one rule about saving
 * ---------------------------------------------------------------------------
 *
 * There is no second copy of the lead anywhere. The row arrives from Postgres
 * with the page, edits are staged in a `draft` of *changed fields only*, and
 * Save sends that draft to the same `PATCH /api/leads/:id` the worklist has
 * always used — one request, the existing whitelist, the existing New→Called
 * promotion. The response is the saved row, and it replaces what is on screen,
 * so what an agent sees after saving is what the database actually holds.
 *
 * **Nothing commits on change.** Picking a status, booking a meeting, typing a
 * note and marking a meeting complete all stage; the sticky bar at the foot is
 * the only thing that writes. That is the worklist's rule, kept deliberately:
 * a mis-click mid-call must cost nothing.
 *
 * The one exception is the call recording, and it is not really an exception —
 * an upload is a file transfer to its own endpoint, it has its own progress and
 * its own failure, and there is no sense in which 25MB of audio can sit in a
 * draft waiting for a button.
 */

/** How long the "Changes saved" confirmation stays up. */
const SAVED_FEEDBACK_MS = 2600;

/** The fields a draft may carry, and what the save bar calls each of them. */
const FIELD_LABELS: Record<keyof LeadEditableFields, string> = {
  status: "Status",
  notes: "Notes",
  callbackDate: "Meeting",
  meetingTime: "Meeting",
  meetingAttendees: "Meeting",
  meetingNotes: "Meeting notes",
  meetingCompletedAt: "Meeting",
};

export default function LeadWorkspace({
  detail,
  initialRecording,
  serverToday,
  backHref,
  nextHref,
}: {
  detail: LeadDetail;
  initialRecording: RecordingSummary | null;
  serverToday: string;
  /** Back to the worklist, on the page it was left on. */
  backHref: string;
  /** The next lead in the list this one was opened from, or null at the end. */
  nextHref: string | null;
}) {
  const router = useRouter();
  const reduced = useReducedMotion();

  // The saved lead. Seeded from the server render and replaced by whatever the
  // PATCH returns — never patched field by field from the draft, so a value the
  // server normalised is the value on screen.
  const [lead, setLead] = useState<Lead>(detail.lead);
  const [recording, setRecording] = useState<RecordingSummary | null>(initialRecording);

  /** Pending edits. `null` means clean. */
  const [draft, setDraft] = useState<Partial<LeadEditableFields> | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const dirty = draft !== null;

  // What the screen shows: the draft where there is one, the saved lead
  // otherwise. Read through this and not through `lead`, so every control
  // reflects the edit in progress.
  const shown: Lead = dirty ? { ...lead, ...draft } : lead;

  /**
   * Stage a change, dropping any field that already matches what is saved.
   *
   * That trimming is what makes "set it back to what it was" clear the pending
   * state rather than leave a no-op edit to commit — and it is why the save bar
   * can name the fields honestly.
   */
  const stage = useCallback(
    (changes: Partial<LeadEditableFields>) => {
      setJustSaved(false);
      setError(null);
      setDraft((current) => {
        const merged = { ...current, ...changes };
        const next: Partial<LeadEditableFields> = {};
        for (const key of Object.keys(merged) as (keyof LeadEditableFields)[]) {
          const value = merged[key];
          if (value === undefined) continue;
          if (Object.is(value, lead[key])) continue;
          // The key indexes the same field on both objects; the assignment is
          // type-safe by construction but not provable to TS.
          (next[key] as unknown) = value;
        }
        return Object.keys(next).length > 0 ? next : null;
      });
    },
    [lead],
  );

  const discard = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!draft || saving) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(lead.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.message ?? `The change could not be saved (${response.status}).`,
        );
      }

      const payload = (await response.json()) as { lead: Lead };
      setLead(payload.lead);
      setDraft(null);
      setJustSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setJustSaved(false), SAVED_FEEDBACK_MS);

      // Re-render the server component behind this screen. It is what refreshes
      // the activity trail's timestamps and re-resolves Next lead against a
      // queue this save may just have moved the lead out of. Local state is
      // untouched by a refresh, so nothing on screen jumps.
      router.refresh();
    } catch (caught) {
      console.error(`Saving lead ${lead.id} failed:`, caught);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach the server. The change was not saved.",
      );
    } finally {
      setSaving(false);
    }
  }, [draft, lead.id, router, saving]);

  // Ctrl/Cmd+S saves. The muscle memory is already there, and the alternative
  // is the browser offering to save the page as HTML.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (!dirty) return;
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dirty, save]);

  // Closing the tab is how an agent finishes with a lead, so it is also the
  // easiest way to lose an unsaved note. The browser's own prompt is the only
  // thing that can interrupt it.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const website = lead.website ? websiteHref(lead.website) : null;
  const whatsapp = whatsappLink(lead.phone);
  const meetingState = callbackState(shown, serverToday);

  const pendingFields = draft
    ? [
        ...new Set(
          (Object.keys(draft) as (keyof LeadEditableFields)[]).map(
            (key) => FIELD_LABELS[key],
          ),
        ),
      ]
    : [];

  return (
    <main className="flex w-full min-w-0 flex-1 flex-col">
      {/* ================= header ==================================== */}
      {/*
       * Sticky under the app's own bar (52px), not at the top of the viewport:
       * two sticky strips fighting for `top: 0` is one covering the other. It
       * stays because the two things it holds — which lead this is, and where
       * the next one is — are the two an agent needs at any scroll position.
       */}
      <header className="ws-topbar">
        <Link href={backHref} className="ws-back">
          <ArrowLeft className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span>Leads</span>
        </Link>

        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />

        <p className="min-w-0 flex-1 truncate text-ui font-semibold tracking-[-0.015em] text-fg">
          {lead.name}
        </p>

        <div className="flex shrink-0 items-center gap-2.5">
          {/* The *saved* status, deliberately — the header is the record, and
              the draft is shown by the control that is editing it. */}
          <span className="hidden sm:block">
            <StatusChip status={lead.status} />
          </span>

          {nextHref ? (
            <Link href={nextHref} className="ui-btn ui-btn-secondary h-8 px-2.5 text-caption">
              <span className="max-sm:sr-only">Next lead</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            </Link>
          ) : (
            <span
              title="This is the last lead in the list you opened it from"
              className="hidden items-center gap-1.5 text-caption text-fg-4 sm:flex"
            >
              End of list
            </span>
          )}
        </div>
      </header>

      {/* ================= identity ================================== */}
      <motion.section
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduced ? 0 : 0.26, ease: [0.22, 0.61, 0.36, 1] }}
        className="ws-identity"
      >
        <div className="mx-auto w-full max-w-[1180px] px-4 py-7 sm:px-6 sm:py-9">
          <h1 className="text-balance text-[clamp(1.5rem,1.1rem+1.6vw,2.125rem)] font-semibold leading-[1.15] tracking-[-0.03em] text-fg">
            {lead.name}
          </h1>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ui text-fg-2">
            {lead.rating !== null && <Rating value={lead.rating} />}
            {lead.categories.length > 0 && (
              <>
                {lead.rating !== null && <Dot />}
                <span className="truncate" title={lead.categories.join(", ")}>
                  {lead.categories.slice(0, 3).join(" · ")}
                </span>
              </>
            )}
            {lead.address && (
              <>
                {(lead.rating !== null || lead.categories.length > 0) && <Dot />}
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin
                    className="h-3.5 w-3.5 shrink-0 text-fg-4"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="truncate">{lead.address}</span>
                </span>
              </>
            )}
          </div>

          {/* The three ways out of this screen and into a conversation. The
              call is the primary action of the whole page, so it is the only
              filled button on it above the save bar.

              A lead with none of the three still gets a line here rather than
              an empty band: "there is no way to contact this one" is the most
              important thing about it, and a gap says nothing. */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {!lead.phone && !whatsapp && !website && (
              <p className="flex items-center gap-2 text-ui text-fg-3">
                <PhoneOff
                  className="h-4 w-4 shrink-0 text-warning"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                No phone or website on this listing.
              </p>
            )}

            {lead.phone && (
              <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="ui-btn ui-btn-primary h-10 px-4">
                <Phone className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span className="tnum font-mono tracking-[-0.01em]">{lead.phone}</span>
              </a>
            )}

            {whatsapp && (
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                className="ui-btn ui-btn-secondary h-10 px-3.5"
              >
                <WhatsAppGlyph />
                WhatsApp
              </a>
            )}

            {website && (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                title={website}
                className="ui-btn ui-btn-secondary h-10 px-3.5"
              >
                <Globe className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                Website
                <ArrowUpRight
                  className="h-3.5 w-3.5 shrink-0 opacity-60"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </a>
            )}
          </div>
        </div>
      </motion.section>

      {/* ================= reference ================================= */}
      <section aria-labelledby="ws-contact" className="border-b border-line">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6">
          <h2 id="ws-contact" className="eyebrow">
            Contact &amp; business
          </h2>

          {/*
           * A definition grid, not a card of rows. Each item is a quiet label
           * over a full-contrast value, and the columns simply reflow — which
           * is what lets eight facts occupy one band of the page instead of
           * eight bordered lines.
           */}
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Phone">
              {lead.phone ? (
                <span className="tnum font-mono text-num text-fg">{lead.phone}</span>
              ) : null}
            </Fact>

            <Fact label="Website">
              {lead.website ? (
                website ? (
                  <a
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={website}
                    className="inline-flex max-w-full items-center gap-1 text-fg transition-colors hover:text-accent"
                  >
                    <span className="truncate underline decoration-line-2 underline-offset-[3px]">
                      {displayWebsite(lead.website)}
                    </span>
                    <ArrowUpRight className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
                  </a>
                ) : (
                  // Scraped text that is not a usable address. Shown — an agent
                  // may recognise it — but never as a link that goes nowhere.
                  <span className="text-fg-2">{displayWebsite(lead.website)}</span>
                )
              ) : null}
            </Fact>

            <Fact label="Address" span>
              {lead.address || null}
            </Fact>

            <Fact label="Category" span>
              {lead.categories.length > 0 ? lead.categories.join(", ") : null}
            </Fact>

            <Fact label="Rating">
              {lead.rating !== null ? (
                <span className="tnum font-mono">{lead.rating.toFixed(1)} / 5</span>
              ) : null}
            </Fact>

            <Fact label="Owner">{lead.owner}</Fact>
          </dl>
        </div>
      </section>

      {/* ================= work + record ============================= */}
      <div className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-6 sm:px-6">
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] xl:gap-8">
          {/* ---- the working column ---------------------------------- */}
          <motion.section
            initial={reduced ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: reduced ? 0 : 0.28,
              delay: reduced ? 0 : 0.05,
              ease: [0.22, 0.61, 0.36, 1],
            }}
            aria-label="Lead workspace"
            className="panel divide-y divide-line overflow-hidden"
          >
            {/* --- status --- */}
            <div className="ws-block-wrap">
              <section aria-labelledby="ws-status" className="ws-block">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="ws-status" className="eyebrow">
                    Lead status
                  </h2>
                  {/* Named rather than implied: an agent about to commit a
                      status should be able to read what they are replacing. */}
                  {draft?.status !== undefined && (
                    <span className="text-meta text-fg-3">
                      Currently saved as{" "}
                      <span className="text-fg-2">{CALL_STATUS_LABELS[lead.status]}</span>
                    </span>
                  )}
                </div>

                <div className="mt-2.5 max-w-sm">
                  <StatusPicker
                    value={shown.status}
                    committed={lead.status}
                    onChange={(status) => stage({ status })}
                  />
                </div>

                <p className="mt-2 text-meta leading-relaxed text-fg-4">
                  Saving an outcome for the first time moves this lead out of the
                  New queue for good.
                </p>
              </section>
            </div>

            {/* --- meeting --- */}
            <div className="ws-block-wrap">
              <section aria-labelledby="ws-meeting" className="ws-block">
                <h2 id="ws-meeting" className="eyebrow">
                  Meeting
                </h2>

                <div className="mt-2.5">
                  {shown.callbackDate ? (
                    <div
                      className={`flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border px-3.5 py-3 ${
                        meetingState === "overdue"
                          ? "border-accent-line bg-accent-soft"
                          : "border-line bg-recessed/60"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                          shown.meetingCompletedAt
                            ? "border-success-line bg-success-bg text-success"
                            : meetingState === "overdue"
                              ? "border-accent-line text-accent"
                              : "border-line-2 text-fg-3"
                        }`}
                      >
                        {shown.meetingCompletedAt ? (
                          <CalendarCheck2 className="h-4 w-4" strokeWidth={1.75} />
                        ) : (
                          <CalendarClock className="h-4 w-4" strokeWidth={1.75} />
                        )}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="text-caption font-medium text-fg">
                          {shown.meetingCompletedAt
                            ? "Meeting complete"
                            : shown.meetingTime
                              ? "Meeting scheduled"
                              : "Call-back scheduled"}
                        </p>
                        <p className="mt-0.5 text-caption text-fg-2">
                          {formatMeetingDay(shown.callbackDate, serverToday)}
                          {shown.meetingTime && (
                            <span className="tnum font-mono">
                              {" · "}
                              {formatMeetingTime(shown.meetingTime)}
                            </span>
                          )}
                        </p>
                        {shown.meetingAttendees && (
                          <p className="mt-1 truncate text-caption text-fg-3">
                            With {shown.meetingAttendees}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setBooking(true)}
                          className="ui-btn ui-btn-secondary h-8 px-2.5 text-caption"
                        >
                          Edit meeting
                        </button>
                        {shown.meetingCompletedAt ? (
                          <button
                            type="button"
                            onClick={() => stage({ meetingCompletedAt: null })}
                            className="ui-btn ui-btn-ghost h-8 px-2.5 text-caption"
                          >
                            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                            Reopen
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => stage({ meetingCompletedAt: serverToday })}
                            className="ui-btn ui-btn-ghost h-8 px-2.5 text-caption"
                          >
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                            Complete
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="ws-empty">
                      <p className="text-ui text-fg-3">No meeting scheduled</p>
                      <button
                        type="button"
                        onClick={() => setBooking(true)}
                        className="ui-btn ui-btn-secondary mt-2.5 h-9"
                      >
                        <CalendarPlus
                          className="h-3.5 w-3.5 shrink-0"
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                        Schedule meeting
                      </button>
                    </div>
                  )}
                </div>

                {/* The agenda notes, kept apart from the call notes below for
                    the reason they are separate columns in Postgres: one is
                    what was said, the other is what to bring. */}
                {(shown.callbackDate || shown.meetingNotes) && (
                  <label className="mt-3 flex flex-col gap-1.5">
                    <span className="field-label">Meeting notes</span>
                    <textarea
                      value={shown.meetingNotes}
                      onChange={(event) => stage({ meetingNotes: event.target.value })}
                      rows={2}
                      placeholder="Agenda, what to bring, what was agreed…"
                      className={`ui-field h-auto w-full resize-y p-2.5 leading-relaxed ${
                        draft?.meetingNotes !== undefined
                          ? "!border-warning-line !bg-warning-bg/40"
                          : ""
                      }`}
                    />
                  </label>
                )}
              </section>
            </div>

            {/* --- notes --- */}
            <div className="ws-block-wrap">
              <section aria-labelledby="ws-notes" className="ws-block">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="ws-notes" className="eyebrow">
                    Call notes
                  </h2>
                  <span className="text-meta text-fg-4">
                    Saved with the rest of your changes
                  </span>
                </div>

                <textarea
                  value={shown.notes}
                  onChange={(event) => stage({ notes: event.target.value })}
                  rows={6}
                  placeholder="What was said, who to ask for next time, what they asked about…"
                  aria-label={`Call notes for ${lead.name}`}
                  className={`ui-field mt-2.5 h-auto w-full resize-y p-3 leading-relaxed ${
                    draft?.notes !== undefined ? "!border-warning-line !bg-warning-bg/40" : ""
                  }`}
                />
              </section>
            </div>

            {/* --- recording --- */}
            <div className="ws-block-wrap">
              <CallRecordingPanel
                leadId={lead.id}
                leadName={lead.name}
                recording={recording}
                // Judged on the saved lead: the upload posts now, and the
                // server reads the row, not the draft.
                eligible={isMeetingLead(lead)}
                onSaved={setRecording}
                onDeleted={() => setRecording(null)}
              />
            </div>
          </motion.section>

          {/* ---- the record ------------------------------------------ */}
          <motion.aside
            initial={reduced ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: reduced ? 0 : 0.28,
              delay: reduced ? 0 : 0.1,
              ease: [0.22, 0.61, 0.36, 1],
            }}
            // Sticky on a desktop, under the app bar and this screen's own
            // header; a plain block on anything narrower, where it stacks
            // beneath the work rather than beside it.
            className="lg:sticky lg:top-[132px]"
          >
            <LeadActivity
              lead={shown}
              today={serverToday}
              createdAt={detail.createdAt}
              updatedAt={detail.updatedAt}
              firstCalledAt={detail.firstCalledAt}
              sourceBatch={detail.sourceBatch}
              recording={recording}
            />
          </motion.aside>
        </div>
      </div>

      {/* ================= save ====================================== */}
      {/*
       * The only thing on this page that writes.
       *
       * Sticky to the foot of the viewport rather than parked at the bottom of
       * the column: the notes box is tall, and a Save button below it is a Save
       * button an agent has to go looking for after typing into it.
       */}
      <AnimatePresence>
        {(dirty || justSaved || error) && (
          <motion.div
            initial={reduced ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
            transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 0.61, 0.36, 1] }}
            className="ws-savebar-wrap"
          >
            <div className="ws-savebar" role={error ? "alert" : "status"}>
              {error ? (
                <p className="min-w-0 flex-1 text-caption text-danger">{error}</p>
              ) : dirty ? (
                <p className="flex min-w-0 flex-1 items-center gap-2 text-caption">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                  />
                  <span className="font-medium text-fg">Unsaved changes</span>
                  <span className="truncate text-fg-3">{pendingFields.join(" · ")}</span>
                </p>
              ) : (
                <p className="flex min-w-0 flex-1 items-center gap-2 text-caption font-medium text-success">
                  <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
                  Changes saved
                </p>
              )}

              {dirty && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={discard}
                    disabled={saving}
                    className="ui-btn ui-btn-ghost h-9"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    aria-busy={saving}
                    className="ui-btn ui-btn-primary h-9"
                  >
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/*
       * Booking reuses the worklist's dialog exactly — including its one rule
       * about status, that a date alone is a call-back and a date with a time
       * marks the lead Interested. What changes is only where the result goes:
       * `onSave` stages it here instead of committing, so a booking joins the
       * same Save the status and the notes are waiting on.
       */}
      {booking && (
        <BookMeetingDialog
          lead={shown}
          onSave={stage}
          onClose={() => setBooking(false)}
        />
      )}
    </main>
  );
}

/** One label-over-value pair in the reference grid. */
function Fact({
  label,
  span = false,
  children,
}: {
  label: string;
  /** Two columns wide on a desktop — for the values that need the room. */
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`min-w-0 ${span ? "lg:col-span-2" : ""}`}>
      <dt className="text-meta font-medium uppercase tracking-[0.05em] text-fg-4">
        {label}
      </dt>
      <dd className="mt-1 break-words text-ui text-fg-2">
        {/* An em dash rather than an empty line: a blank value is a fact about
            the listing, and a gap in a grid just looks like a rendering bug. */}
        {children || <span className="text-fg-4">—</span>}
      </dd>
    </div>
  );
}

/** Five stars, filled to the rating. The number is still shown beside them. */
function Rating({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={`Rated ${value.toFixed(1)} out of 5`}>
      <span aria-hidden="true" className="flex items-center gap-0.5">
        {[0, 1, 2, 3, 4].map((index) => (
          <Star
            key={index}
            className={`h-3.5 w-3.5 ${
              index < Math.round(value) ? "fill-current text-st-gold" : "text-line-2 fill-current"
            }`}
            strokeWidth={0}
          />
        ))}
      </span>
      <span className="tnum font-mono text-caption font-medium text-fg">
        {value.toFixed(1)}
      </span>
      <span className="sr-only">out of 5</span>
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-fg-4">
      ·
    </span>
  );
}

/** The WhatsApp glyph, drawn as one path so it inherits `currentColor`. */
function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8.02 1.6a6.35 6.35 0 0 0-5.4 9.7l-.94 3.44 3.53-.92a6.35 6.35 0 1 0 2.81-12.22Zm0 1.16a5.19 5.19 0 1 1-2.64 9.65l-.2-.12-2.1.55.56-2.04-.13-.21A5.19 5.19 0 0 1 8.02 2.76Zm-2.3 2.51c-.12 0-.31.05-.47.23-.16.18-.62.6-.62 1.47s.63 1.7.72 1.82c.09.12 1.23 1.96 3.04 2.67 1.5.59 1.81.47 2.14.44.33-.03 1.06-.43 1.21-.85.15-.42.15-.78.11-.85-.04-.07-.16-.12-.33-.2-.18-.09-1.06-.53-1.22-.59-.17-.06-.29-.09-.4.09-.13.17-.47.58-.57.7-.11.12-.21.13-.39.05-.18-.09-.76-.28-1.44-.9a5.4 5.4 0 0 1-1-1.24c-.1-.18-.01-.28.08-.36.08-.09.18-.22.27-.33.09-.11.12-.19.18-.31.06-.12.03-.23-.01-.32-.05-.09-.4-.97-.55-1.32-.14-.35-.29-.3-.4-.3l-.35-.01Z"
      />
    </svg>
  );
}
