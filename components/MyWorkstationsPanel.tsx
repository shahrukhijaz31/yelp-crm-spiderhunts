"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertCircle, Laptop, Loader2, ShieldCheck, Unplug } from "lucide-react";

import type { WorkstationCard } from "@/lib/workstations";
import { disconnectWorkstation } from "@/lib/workstationsClient";
import { formatDate } from "@/lib/portalTime";

/**
 * Profile → Your workstations: the computers reporting under your account, and
 * the button that ends one.
 *
 * This screen is the reason the Monitor's credential is allowed to renew
 * itself indefinitely (see "Why the refresh window slides" in
 * `lib/monitorAuth.ts`). A connection with no expiry needs somewhere a person
 * can see it and stop it; without this page, that change would have been a
 * loss. It is also where an agent lands after connecting, so an approval they
 * did not mean to give can be undone in one click.
 *
 * Disconnect is behind a confirmation, and the confirmation says what the
 * action does *not* do. "Disconnect" could reasonably be read as ending a
 * shift or signing out of the portal; it does neither, and the person pressing
 * it should not have to find that out afterwards.
 */
export default function MyWorkstationsPanel({
  workstations,
}: {
  workstations: WorkstationCard[];
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState<WorkstationCard | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect(device: WorkstationCard) {
    if (working) return;
    setWorking(true);
    setError(null);

    const result = await disconnectWorkstation(device.id);

    if (!result.ok) {
      setError(result.message);
      setWorking(false);
      return;
    }

    setConfirming(null);
    setWorking(false);
    // The list is read on the server, so this is what refreshes it.
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="page-title">Your workstations</h1>
        <p className="mt-3 page-intro">
          The computers running SpiderHunts Monitor against your account. You
          connect one once; it stays connected until you disconnect it here or
          in the Monitor itself.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-bg px-3 py-2.5 text-caption leading-relaxed text-danger"
        >
          <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {workstations.length === 0 ? (
        <section className="panel flex flex-col gap-3 px-6 py-6">
          <h2 className="text-cell font-semibold text-fg">No workstations connected</h2>
          <p className="text-ui leading-relaxed text-fg-3">
            Install SpiderHunts Monitor from{" "}
            <a href="/downloads" className="underline underline-offset-2 hover:text-fg-2">
              Downloads
            </a>
            , then press Connect in it. It will open this portal and ask you to
            confirm.
          </p>
        </section>
      ) : (
        <section className="panel flex flex-col divide-y divide-line px-0 py-0">
          {workstations.map((device) => (
            <article key={device.id} className="flex items-start gap-3.5 px-6 py-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line-2 bg-surface text-fg-2">
                <Laptop className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </span>

              <div className="min-w-0 flex-1">
                <h2 className="text-cell font-semibold text-fg">
                  {device.deviceName ?? "Unnamed computer"}
                </h2>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {device.platform && (
                    <span className="chip border border-line-2 text-fg-3">{device.platform}</span>
                  )}
                  {device.appVersion && (
                    <span className="chip border border-line-2 font-mono text-fg-3">
                      Monitor {device.appVersion}
                    </span>
                  )}
                </div>

                <p className="mt-2.5 text-caption leading-relaxed text-fg-4">
                  Connected {formatDay(device.connectedAt)} · last seen{" "}
                  {formatAgo(device.lastSeenAt)}
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setConfirming(device);
                }}
                className="ui-btn ui-btn-ghost shrink-0"
              >
                <Unplug className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                Disconnect
              </button>
            </article>
          ))}
        </section>
      )}

      <p className="flex items-start gap-2.5 text-caption leading-relaxed text-fg-4">
        <ShieldCheck className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        A workstation you do not recognise should be disconnected and reported
        to an administrator. Nothing is recorded outside your shift, whether or
        not the Monitor is running.
      </p>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="disconnect-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="panel flex w-full max-w-md flex-col gap-4 px-6 py-6">
            <h2 id="disconnect-title" className="text-cell font-semibold text-fg">
              Disconnect {confirming.deviceName ?? "this computer"}?
            </h2>

            <p className="text-ui leading-relaxed text-fg-3">
              SpiderHunts Monitor on that computer will be signed out and will
              stop reporting. To use it again, press Connect in the Monitor and
              approve it here.
            </p>

            <p className="text-caption leading-relaxed text-fg-4">
              This does not end your shift and does not sign you out of the
              portal.
            </p>

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={working}
                className="ui-btn ui-btn-ghost"
              >
                Keep it connected
              </button>
              <button
                type="button"
                onClick={() => void disconnect(confirming)}
                disabled={working}
                aria-busy={working}
                className="ui-btn ui-btn-danger"
              >
                {working && (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
                )}
                {working ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** `12 Mar 2026`. A date, because "connected" is a one-off event. */
function formatDay(iso: string): string {
  return formatDate(iso, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * `4 minutes ago`. Relative, because what a reader wants from "last seen" is
 * whether it is *now* — and because a cached page showing an absolute time
 * would look authoritative while being wrong.
 */
function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));

  if (seconds < 90) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
