"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

interface OfficeNetworkRow {
  id: string;
  ip: string;
  label: string;
}

/**
 * The office's public addresses — what decides whether a contributor's time is
 * recorded as office or remote (`lib/workLocation.ts`).
 *
 * Saves each change straight away through `/api/office-networks`, which is
 * administrator-only. A change affects time recorded from then on; stretches
 * already recorded keep their label.
 */
export default function OfficeNetworksPanel({
  initialNetworks,
  yourIp,
}: {
  initialNetworks: OfficeNetworkRow[];
  /** The address this page was loaded from, or "unknown". */
  yourIp: string;
}) {
  const [networks, setNetworks] = useState(initialNetworks);
  const [ip, setIp] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = (await response.json().catch(() => null)) as {
        networks?: OfficeNetworkRow[];
        message?: string;
      } | null;
      if (!response.ok || !payload?.networks) {
        throw new Error(payload?.message ?? `The change was not saved (${response.status}).`);
      }
      setNetworks(payload.networks);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change was not saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(value: string, name: string) {
    const ok = await send("/api/office-networks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: value, label: name }),
    });
    if (ok) {
      setIp("");
      setLabel("");
    }
  }

  const knownIp = yourIp !== "unknown";
  const yoursListed = networks.some((network) => network.ip === yourIp);

  return (
    <section className="panel flex flex-col gap-4 px-5 py-5">
      <div>
        <h2 className="text-cell font-semibold text-fg">Office network</h2>
        <p className="mt-2 text-ui leading-relaxed text-fg-3">
          A contributor&rsquo;s time is recorded as <em>Office</em> while their
          laptop is on one of these addresses, and <em>Remote</em> anywhere else.
          Changes apply from now on; time already recorded keeps its label.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {networks.length === 0 && (
          <li className="px-3.5 py-3 text-ui text-fg-3">
            No office addresses — every contributor is recorded as remote.
          </li>
        )}
        {networks.map((network) => (
          <li key={network.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="tnum font-mono text-ui text-fg">{network.ip}</span>
            {network.label && <span className="text-caption text-fg-3">{network.label}</span>}
            {network.ip === yourIp && (
              <span className="text-meta text-fg-4">· this is where you are now</span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void send(`/api/office-networks/${encodeURIComponent(network.id)}`, {
                  method: "DELETE",
                })
              }
              aria-label={`Remove ${network.ip}`}
              title="Remove"
              className="ui-btn ui-btn-ghost ml-auto h-8 px-2 hover:text-danger"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add(ip, label);
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1">
          <span className="field-label">IP address</span>
          <input
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            placeholder="39.60.232.90"
            className="ui-field tnum h-9 w-44 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="field-label">Label</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Office"
            maxLength={80}
            className="ui-field h-9 w-40"
          />
        </label>
        <button type="submit" disabled={busy || !ip.trim()} className="ui-btn ui-btn-primary h-9">
          Add
        </button>
        {knownIp && !yoursListed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void add(yourIp, "Office")}
            className="ui-btn ui-btn-ghost h-9"
          >
            Add the address I&rsquo;m on ({yourIp})
          </button>
        )}
      </form>

      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
