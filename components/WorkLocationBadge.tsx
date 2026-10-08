"use client";

import { useEffect, useRef, useState } from "react";
import { Building2, Check, House, MapPin } from "lucide-react";

import { useWorkSession } from "./WorkSessionProvider";
import {
  WORK_LOCATIONS,
  WORK_LOCATION_LABELS,
  type WorkLocation,
  type WorkLocationStatus,
} from "@/lib/workLocationRules";

const ICONS = { office: Building2, remote: House } as const;

/**
 * Where this person is working — Office or Remote — beside the shift clock.
 *
 * **Chosen, not detected** (`lib/workLocation.ts`): the team's VPN makes the
 * office and home look the same from the server. So at the start of every
 * shift this asks "Where are you working today?" and waits for an answer — the
 * time is not labelled until it has one — and the badge is how they switch
 * when they move. Each switch starts a new stretch, so a split day records as
 * two.
 *
 * The status comes from the heartbeat (`WorkSessionProvider`), which is also
 * how a new shift's question appears without a reload.
 */
export default function WorkLocationBadge() {
  const { location: status, setLocation } = useWorkSession();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!status) return null;

  async function choose(next: WorkLocation) {
    if (saving) return;
    if (status && next === status.location) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/work-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: next }),
      });
      const payload = (await response.json().catch(() => null)) as {
        location?: WorkLocationStatus;
        message?: string;
      } | null;
      if (!response.ok || !payload?.location) {
        throw new Error(payload?.message ?? "Could not save where you are working.");
      }
      setLocation(payload.location);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save where you are working.");
    } finally {
      setSaving(false);
    }
  }

  // --- the start-of-shift question --------------------------------------
  if (status.needsChoice) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-location-question"
      >
        {/* No way to dismiss it but to answer: the shift's time is not labelled
            until it has one, and an unanswered question would just come back
            on the next heartbeat. */}
        <div aria-hidden="true" className="absolute inset-0 bg-base/60 backdrop-blur-[3px]" />
        <div className="panel-float pop-in relative w-full max-w-sm p-5 [--pop-origin:center]">
          <h2 id="work-location-question" className="text-cell font-semibold text-fg">
            Where are you working today?
          </h2>
          <p className="mt-1.5 text-caption leading-relaxed text-fg-3">
            If you move during the day, change it from the badge beside your
            clock and the rest of the day is recorded there.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            {WORK_LOCATIONS.map((option) => {
              const Icon = ICONS[option];
              return (
                <button
                  key={option}
                  type="button"
                  disabled={saving}
                  onClick={() => void choose(option)}
                  className="ui-btn ui-btn-secondary h-20 flex-col gap-1.5 text-ui disabled:opacity-60"
                >
                  <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                  {WORK_LOCATION_LABELS[option]}
                </button>
              );
            })}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-caption text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Not on the clock yet: nothing to say.
  if (!status.location) return null;

  const Icon = ICONS[status.location];

  // --- the badge, and switching -----------------------------------------
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Working from: ${WORK_LOCATION_LABELS[status.location]} — click to change`}
        className="chip flex items-center gap-1.5 border border-line-2 text-caption text-fg-2 transition-colors hover:text-fg"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {WORK_LOCATION_LABELS[status.location]}
      </button>

      {open && (
        <div role="menu" className="panel-float pop-in absolute right-0 top-full z-50 mt-2 w-60 p-1.5">
          <p className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-meta text-fg-3">
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Where are you working right now?
          </p>
          {WORK_LOCATIONS.map((option) => {
            const OptionIcon = ICONS[option];
            const active = option === status.location;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={saving}
                onClick={() => void choose(option)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-ui text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-60"
              >
                <OptionIcon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="flex-1">{WORK_LOCATION_LABELS[option]}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} aria-hidden="true" />}
              </button>
            );
          })}
          {error && (
            <p role="alert" className="px-2.5 pb-1 pt-1.5 text-meta text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
