"use client";

import { useState } from "react";

import {
  DEFAULT_PRODUCTIVITY_CONFIG,
  METRIC_DEFINITIONS,
  METRIC_FIELDS,
  METRIC_KEYS,
  METRIC_LABELS,
  totalWeight,
  type MetricKey,
  type ProductivityConfig,
  type ProductivityConfigInput,
} from "@/lib/productivityRules";

/**
 * Productivity settings — ADMIN only, and the only write path to the targets
 * and weights.
 *
 * **The form validates, and so does the server.** The running total below the
 * weights is live so an administrator can see the hundred before they submit,
 * and the button is disabled until it is one — but that is convenience, and
 * `validateProductivityConfig` on the server is what actually decides. Both are
 * the same rule read from the same module; neither is the other's substitute.
 *
 * **All ten values are sent together.** The weights have to total 100, which is
 * a property of the set and not of any one of them, so a form that could submit
 * a single field would be a form that could not be checked. That is also why
 * the endpoint is a PUT.
 *
 * **What changing these does to history**, stated on the screen rather than
 * left to be discovered: reports always use the configuration in force at the
 * moment they are run, so raising a target changes last month's scores too.
 */

type Draft = Record<keyof ProductivityConfigInput, string>;

function draftOf(config: ProductivityConfigInput): Draft {
  return {
    callsTarget: String(config.callsTarget),
    leadsTarget: String(config.leadsTarget),
    meetingsTarget: String(config.meetingsTarget),
    followUpsTarget: String(config.followUpsTarget),
    activityTarget: String(config.activityTarget),
    callsWeight: String(config.callsWeight),
    leadsWeight: String(config.leadsWeight),
    meetingsWeight: String(config.meetingsWeight),
    activityWeight: String(config.activityWeight),
    followUpsWeight: String(config.followUpsWeight),
  };
}

/** The units each target is expressed in, for the suffix beside the input. */
const TARGET_UNITS: Record<MetricKey, string> = {
  calls: "per worked day",
  leads: "per worked day",
  meetings: "per worked day",
  activity: "% of tracked time",
  followUps: "per worked day",
};

export default function ProductivitySettingsPanel({
  initialConfig,
}: {
  initialConfig: ProductivityConfig;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initialConfig));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const numeric = (value: string): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const weights = {
    callsWeight: numeric(draft.callsWeight),
    leadsWeight: numeric(draft.leadsWeight),
    meetingsWeight: numeric(draft.meetingsWeight),
    activityWeight: numeric(draft.activityWeight),
    followUpsWeight: numeric(draft.followUpsWeight),
  };
  const total = totalWeight(weights);

  const set = (field: keyof Draft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const body = Object.fromEntries(
      Object.entries(draft).map(([field, value]) => [field, numeric(value)]),
    );

    try {
      const response = await fetch("/api/reports/productivity/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        config?: ProductivityConfig;
        message?: string;
      };

      if (!response.ok || !payload.config) {
        setError(payload.message ?? "Could not save these settings.");
        return;
      }

      setConfig(payload.config);
      setDraft(draftOf(payload.config));
      setSaved(true);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function restoreDefaults() {
    setDraft(draftOf(DEFAULT_PRODUCTIVITY_CONFIG));
    setSaved(false);
    setError(null);
  }

  return (
    <form onSubmit={save} className="panel flex flex-col gap-5 px-5 py-5">
      <div>
        <h2 className="text-cell font-semibold text-fg">Agent productivity</h2>
        <p className="mt-2 text-ui leading-relaxed text-fg-3">
          The targets each agent&rsquo;s output is measured against, and how much
          each metric counts towards their score. Agents cannot see or change any
          of this, and administrators are never scored.
        </p>
      </div>

      {/* --- targets ------------------------------------------------------ */}
      <fieldset className="flex flex-col gap-3">
        <legend className="eyebrow">Targets</legend>
        <p className="text-meta text-fg-4">
          Counts are per agent per <em>worked</em> day — a day the agent had a
          work session. An agent on the clock for three days of a week is
          measured against three days of target, not seven.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {METRIC_KEYS.map((key) => {
            const field = METRIC_FIELDS[key].target;
            return (
              <label key={field} className="flex flex-col gap-1.5">
                <span className="field-label">{METRIC_LABELS[key]}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={key === "activity" ? 100 : 10000}
                    step={1}
                    required
                    value={draft[field]}
                    onChange={(event) => set(field, event.target.value)}
                    className="ui-field h-9 w-[104px]"
                  />
                  <span className="text-meta text-fg-4">{TARGET_UNITS[key]}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* --- weights ------------------------------------------------------ */}
      <fieldset className="flex flex-col gap-3">
        <legend className="eyebrow">Weights</legend>
        <p className="text-meta text-fg-4">
          Percentage points, and they must total exactly 100. Activity is
          deliberately the smallest by default: it measures keyboard and mouse
          input, which a good phone call does not produce.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {METRIC_KEYS.map((key) => {
            const field = METRIC_FIELDS[key].weight;
            return (
              <label key={field} className="flex flex-col gap-1.5">
                <span className="field-label">{METRIC_LABELS[key]}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    required
                    value={draft[field]}
                    onChange={(event) => set(field, event.target.value)}
                    className="ui-field h-9 w-[104px]"
                  />
                  <span className="text-meta text-fg-4">%</span>
                </span>
                <span className="text-meta text-fg-4">{METRIC_DEFINITIONS[key]}</span>
              </label>
            );
          })}
        </div>

        <p
          className={`tnum text-ui ${total === 100 ? "text-success" : "text-danger"}`}
          aria-live="polite"
        >
          Total: {total}%{total === 100 ? "" : " — the five weights must total 100%."}
        </p>
      </fieldset>

      {/* --- actions ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" disabled={busy || total !== 100} className="ui-btn ui-btn-primary h-9">
          {busy ? "Saving…" : "Save settings"}
        </button>
        <button type="button" onClick={restoreDefaults} className="ui-btn ui-btn-ghost h-9">
          Restore defaults
        </button>

        <p className="text-meta text-fg-4" aria-live="polite">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : saved ? (
            <span className="text-success">Saved.</span>
          ) : config.isDefault ? (
            "Currently using the shipped defaults."
          ) : (
            `Last changed ${new Date(config.updatedAt!).toLocaleString()}${
              config.updatedByName ? ` by ${config.updatedByName}` : ""
            }.`
          )}
        </p>
      </div>

      <p className="text-meta text-fg-4">
        Changing these changes every productivity report, including reports about
        earlier periods — scores are calculated on read from the configuration in
        force at that moment, and no history of previous weights is kept. Nothing
        stored about an agent changes.
      </p>
    </form>
  );
}
