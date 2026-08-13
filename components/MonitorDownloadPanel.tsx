"use client";

import { useState } from "react";
import { AlertCircle, Download, Loader2, Monitor, ShieldCheck } from "lucide-react";

/**
 * Account → Downloads: the SpiderHunts Monitor installer.
 *
 * One card, because there is one thing to download. It follows the shape the
 * account screens already use — a page title, an intro that says what the screen
 * is for, and a single `panel` holding the work — held to the same narrow column
 * as Change password, since this is a thing to read and act on once rather than
 * a list to scan.
 *
 * **Everything factual here comes from the server.** The version, the filename
 * and the size are props rendered by `app/(portal)/downloads/page.tsx` from
 * `lib/monitorRelease.ts`; nothing in this file knows a version number, and
 * there is no path anywhere in it to know. That is what stops the screen from
 * drifting away from the file actually sitting on the box.
 *
 * **The button is not a permission.** It is drawn for both roles because both
 * may download, and if it were drawn for someone who may not, the endpoint would
 * still refuse them — `apiUser()` resolves the session from Postgres on every
 * request. Nothing here is load-bearing for access.
 */

export interface MonitorDownloadInfo {
  name: string;
  platform: string;
  version: string;
  fileName: string;
  available: boolean;
  /** Bytes, or null when the installer is not on the server. */
  sizeBytes: number | null;
}

/** The endpoint the browser is sent to. The only download URL in the app. */
const DOWNLOAD_URL = "/api/downloads/monitor";
const INFO_URL = "/api/downloads/monitor/info";

const UNAVAILABLE =
  "SpiderHunts Monitor is temporarily unavailable. Please try again later.";

export default function MonitorDownloadPanel({ info }: { info: MonitorDownloadInfo }) {
  const [checking, setChecking] = useState(false);
  // Starts from the server's answer, and is replaced by whatever the re-check
  // below finds. A tab left open overnight should not keep promising a file
  // that was swapped out at 6am.
  const [available, setAvailable] = useState(info.available);
  const [size, setSize] = useState(info.sizeBytes);
  const [error, setError] = useState<string | null>(null);

  /**
   * Ask whether the file is still there, then hand the browser the URL.
   *
   * The check is one small JSON request; the download itself is an anchor the
   * browser follows, *not* a `fetch`. That distinction matters at this size:
   * fetching would pull 77MB through JavaScript and into memory before anything
   * reached the disk, with no progress bar and no resume, where following a
   * link to an `attachment` response is the browser's own download manager
   * doing what it is for.
   *
   * And not `router.push` either: the target is an API route rather than a
   * page, so a client-side navigation would ask for an RSC payload and get an
   * executable. The anchor is the real, plain browser navigation this needs.
   */
  async function download() {
    if (checking) return;

    setChecking(true);
    setError(null);

    try {
      const response = await fetch(INFO_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));

      const fresh = (await response.json()) as MonitorDownloadInfo;
      setAvailable(fresh.available);
      setSize(fresh.sizeBytes);

      if (!fresh.available) {
        setError(UNAVAILABLE);
        return;
      }

      // `download` names the file for the browser; the server's
      // Content-Disposition says the same thing, and either alone would be
      // enough. Removed from the document immediately — it exists for one
      // click.
      const link = document.createElement("a");
      link.href = DOWNLOAD_URL;
      link.download = fresh.fileName || info.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      // Includes the signed-out case, where the endpoint answers 401 JSON. The
      // sentence is the same either way: nothing here tells an agent anything
      // about the server, and the next page load will send them to sign in.
      setError(UNAVAILABLE);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header>
        <h1 className="page-title">Downloads</h1>
        <p className="mt-3 page-intro">
          The desktop software issued with your account. Install it on the
          Windows machine you work from, then sign in to it with the same
          username and password you use here.
        </p>
      </header>

      <section className="panel flex flex-col gap-5 px-6 py-6">
        <div className="flex items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line-2 bg-surface text-fg-2">
            <Monitor className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-cell font-semibold text-fg">{info.name}</h2>
            <p className="mt-2 text-ui leading-relaxed text-fg-3">
              Download the SpiderHunts Monitor desktop application required for
              employee monitoring, activity tracking, screenshots and
              application usage tracking.
            </p>

            {/* Platform, version and size as three quiet chips rather than a
                definition list: they are labels on one object, and a table of
                three rows would be more furniture than fact. */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="chip border border-line-2 text-fg-3">{info.platform}</span>
              <span className="chip border border-line-2 font-mono text-fg-3">
                Version {info.version}
              </span>
              {size !== null && (
                <span className="chip border border-line-2 text-fg-3">
                  {formatSize(size)}
                </span>
              )}
            </div>

            {/* The filename, so somebody can confirm that what landed in their
                Downloads folder is what this page offered. Monospace and
                breakable — it is long, and it must not push the panel wide. */}
            <p className="mt-2.5 break-all font-mono text-meta text-fg-4">
              {info.fileName}
            </p>
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-bg px-3 py-2.5 text-caption leading-relaxed text-danger"
          >
            <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button
            type="button"
            onClick={() => void download()}
            // Disabled only when the server has already said the file is not
            // there. Every other failure is discovered on the click and
            // answered with the sentence above, because a button that is dead
            // for a reason nobody can see is worse than one that explains
            // itself.
            disabled={!available || checking}
            aria-busy={checking}
            className="ui-btn ui-btn-primary"
          >
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            )}
            {checking ? "Preparing…" : "Download Monitor"}
          </button>

          {!available && !error && (
            <p role="status" className="text-caption leading-relaxed text-fg-3">
              {UNAVAILABLE}
            </p>
          )}
        </div>
      </section>

      <p className="flex items-start gap-2.5 text-caption leading-relaxed text-fg-4">
        <ShieldCheck className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        This is the official build, served from the portal and only to signed-in
        accounts. Do not install a copy of SpiderHunts Monitor obtained anywhere
        else.
      </p>
    </div>
  );
}

/**
 * Bytes as an approximate MB, the way an operating system's download list
 * writes it. Whole megabytes above 10, one decimal below, so a 77MB installer
 * reads "77 MB" and a 2.4MB one does not round to "2 MB".
 *
 * Decimal MB (10^6) rather than MiB, deliberately: it is the unit Windows and
 * every browser download panel show, and this number exists to be recognised on
 * the other screen, not to be exact.
 */
function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
