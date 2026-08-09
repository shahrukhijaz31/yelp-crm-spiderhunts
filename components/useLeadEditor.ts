"use client";

import { useCallback, useRef } from "react";

import type { Lead, LeadEditableFields } from "@/lib/types";

/**
 * The app's one lead-mutation path, as a hook.
 *
 * It lived inside `LeadsProvider` while that store was the only holder of lead
 * rows. The worklist now keeps a page of its own — it no longer has, or wants,
 * the whole table — so the logic moved here rather than being written a second
 * time next to it. Two implementations of "write optimistically, then reconcile
 * with the server" is exactly how the two screens start disagreeing about what
 * a failed save looks like.
 *
 * Behaviour is unchanged from the original, and the reasoning is worth keeping
 * with it: the row repaints on this tick because the agent is on a call and
 * cannot wait a round trip to see the status they just picked, and a failed
 * save puts the old value back.
 *
 * `onSaved` fires after the server has confirmed the write. The worklist uses
 * it to re-read the headline counts, which it can no longer derive itself.
 */
export function useLeadEditor(
  leads: Lead[],
  setLeads: React.Dispatch<React.SetStateAction<Lead[]>>,
  onSaved?: () => void,
): (id: string, changes: Partial<LeadEditableFields>) => void {
  // Kept in step with `leads` so the callback can read the pre-edit values
  // without putting that read inside a state updater, which React may call
  // more than once per commit.
  const leadsRef = useRef(leads);
  leadsRef.current = leads;

  // Held in a ref so a caller passing an inline arrow does not give every lead
  // row a new `onUpdate` identity on every render.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  return useCallback(
    (id: string, changes: Partial<LeadEditableFields>) => {
      const keys = Object.keys(changes) as (keyof LeadEditableFields)[];
      if (keys.length === 0) return;

      const before = leadsRef.current.find((lead) => lead.id === id);
      if (!before) return;

      // Optimistic: the row repaints on this tick. The agent is on a call and
      // cannot wait a round trip to see the status they just picked.
      setLeads((current) =>
        current.map((lead) => (lead.id === id ? { ...lead, ...changes } : lead)),
      );

      void (async () => {
        let saved = false;
        try {
          const response = await fetch(`/api/leads/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
          });
          saved = response.ok;
          if (!saved) {
            console.error(
              `Saving lead ${id} failed (${response.status}):`,
              await response.text(),
            );
          }
        } catch (error) {
          console.error(`Saving lead ${id} failed:`, error);
        }

        if (saved) {
          onSavedRef.current?.();
          return;
        }

        // Roll back — but only the fields this call changed, and only if they
        // still hold what this call wrote. If the agent has since typed
        // something else into the same field, their newer value is the one that
        // matters and a rollback would throw it away.
        setLeads((current) =>
          current.map((lead) => {
            if (lead.id !== id) return lead;
            const untouched = keys.every((key) => Object.is(lead[key], changes[key]));
            if (!untouched) return lead;

            const restored = { ...lead };
            for (const key of keys) {
              // `key` indexes the same field on both objects; the assignment is
              // type-safe by construction but not provable to TS.
              (restored[key] as unknown) = before[key];
            }
            return restored;
          }),
        );
      })();
    },
    [setLeads],
  );
}
