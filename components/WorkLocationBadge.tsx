"use client";

import { useEffect, useRef, useState } from "react";
import { Building2, Check, House } from "lucide-react";

import { useWorkSession } from "./WorkSessionProvider";
import {
  WORK_LOCATIONS,
  WORK_LOCATION_LABELS,
  type WorkLocation,
  type WorkLocationStatus,
} from "@/lib/workLocationRules";

const ICONS = { office: Building2, remote: House } as const;

/**
 * Where a contributor's time is being recorded — Office or Remote — beside the
 * shift clock, with a way to correct it.
 *
 * The status comes from the heartbeat (`WorkSessionProvider`), so it follows
 * them between the office and home within a minute without anybody pressing
 * anything. The menu is for when the network is wrong: a choice that differs
 * from what was detected is held until their network next changes, and then
 * detection takes over again (`lib/workLocation.ts`). Choosing what was
 * detected clears it.
 *
 * Draws nothing until the server has given a status — an unknown address
 * records nothing, and a badge guessing would say something untrue.
 */
export default function WorkLocationBadge() {
  const { location, setLocation } = useWorkSession();
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

  if (!location) return null;

  async function choose(next: WorkLocation) {
    if (saving || !location) return;
    if (next === location.location) {
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
        throw new Error(payload?.message ?? "Could not change where you are working.");
      }
      setLocation(payload.location);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change where you are working.");
    } finally {
      setSaving(false);
    }
  }

  const Icon = ICONS[location.location];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          location.manual
            ? `Recording ${WORK_LOCATION_LABELS[location.location]} — set by you`
            : `Recording ${WORK_LOCATION_LABELS[location.location]} — from your network`
        }
        className="chip flex items-center gap-1.5 border border-line-2 text-caption text-fg-2 transition-colors hover:text-fg"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {WORK_LOCATION_LABELS[location.location]}
        {location.manual && <span className="text-fg-4">· you</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="panel-float pop-in absolute right-0 top-full z-50 mt-2 w-64 p-1.5"
        >
          <p className="px-2.5 pb-1.5 pt-1 text-meta text-fg-3">
            Your network says{" "}
            <span className="font-medium text-fg-2">
              {WORK_LOCATION_LABELS[location.detected]}
            </span>
            . Change it only if that is wrong — it switches back when your
            network changes.
          </p>
          {WORK_LOCATIONS.map((option) => {
            const OptionIcon = ICONS[option];
            const active = option === location.location;
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
