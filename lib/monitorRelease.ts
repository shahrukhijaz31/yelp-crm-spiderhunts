import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * The SpiderHunts Monitor installer the portal hands out — what it is, where it
 * is, and how its bytes leave the server.
 *
 * One installer, described in one place. Every other file in this feature —
 * the download route, the metadata route and the panel an agent sees — reads
 * the version, the filename and the size from here, so shipping 0.2.0 is a
 * change to `DEFAULT_VERSION` (or to `MONITOR_VERSION` on the box) rather than
 * a hunt through three files for a string.
 *
 * **There is no parameter anywhere in this module.** No caller passes a name, a
 * key, a path or an id, so there is nothing to traverse with and nothing to
 * point at a second file: the one path that can be opened is the one the server
 * itself is configured with, resolved here and never echoed back. That is the
 * same shape `lib/screenshotStorage.ts` uses, minus the key — screenshots need
 * a key because there are millions of them, and this is one file.
 *
 * **The installer is not a secret and the endpoint is still authenticated.**
 * Anyone who runs the Monitor already has the binary; the reason
 * `/api/downloads/monitor` checks the session is that an unauthenticated
 * download URL is a free advertisement of what this company monitors and with
 * what, and it would be the one route in the application that answers a
 * stranger with 77MB.
 *
 * **The file lives outside the release tree**, for the reason recordings and
 * screenshots do: `deploy/deploy.sh` replaces the slot directory wholesale on
 * every release, so an installer stored inside it would vanish at the next
 * deploy and a rollback could not bring it back. Production points
 * `MONITOR_INSTALLER_PATH` at `/var/lib/leadportal/downloads/…`, which
 * `deploy/provision.sh` creates and the systemd unit can read.
 */

/**
 * The version of the installer sitting on the server.
 *
 * A constant rather than something read from the file, because a Windows PE
 * does not carry its version anywhere a Node process should be parsing, and
 * because "what version is this" must have an answer even when the file is
 * missing — the panel says "temporarily unavailable" for 0.1.0, not for
 * nothing.
 */
const DEFAULT_VERSION = "0.1.0";

/**
 * `x.y.z`, optionally with a pre-release tail. Anything else is a typo in
 * `/etc/leadportal/env`, and a typo should cost a log line rather than a
 * download button labelled "Version undefined".
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The Windows executable media type, registered with IANA and what a PE
 * actually is. `Content-Disposition: attachment` is what makes the browser save
 * rather than navigate — the type is not carrying that weight — and
 * `X-Content-Type-Options: nosniff` on the response stops a browser looking for
 * a better idea about a file it is only ever going to write to disk.
 */
export const INSTALLER_CONTENT_TYPE = "application/vnd.microsoft.portable-executable";

/** Warn once per key, so a bad value does not print on every request. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[monitor-release] ${message}`);
}

/**
 * Read at call time, never at module scope.
 *
 * The reason `lib/screenshotPolicy.ts` gives: a module-level const is evaluated
 * during `next build`, where nothing from `/etc/leadportal/env` is set, and the
 * baked-in default would then outlive every later change to the file.
 */
function version(): string {
  const configured = process.env.MONITOR_VERSION?.trim();
  if (!configured) return DEFAULT_VERSION;

  if (!VERSION_PATTERN.test(configured)) {
    warnOnce("MONITOR_VERSION", `MONITOR_VERSION is not a version number; using ${DEFAULT_VERSION}.`);
    return DEFAULT_VERSION;
  }

  return configured;
}

/** What the browser saves the file as. Derived from the version, never from disk. */
function fileName(release: string): string {
  return `SpiderHunts-Monitor-Windows-${release}-Setup.exe`;
}

/**
 * Everything the UI is allowed to know about the installer.
 *
 * Deliberately *not* in here: the path. The panel needs a name, a platform, a
 * version, a filename and a size; telling it where the file sits on the server
 * would be telling every signed-in browser, and the download route needs no
 * help from the client to find its own file.
 */
export interface MonitorRelease {
  /** Product name, as it appears in the installer and in the UI. */
  name: string;
  platform: string;
  version: string;
  /** The name the browser writes to disk. */
  fileName: string;
}

export function monitorRelease(): MonitorRelease {
  const release = version();
  return {
    name: "SpiderHunts Monitor",
    platform: "Windows",
    version: release,
    fileName: fileName(release),
  };
}

/**
 * Where the installer is.
 *
 * Development defaults to `.data/downloads/<filename>` inside the project,
 * which `.gitignore` already covers, so a fresh clone needs no configuration
 * and a developer can drop the exe there and click the button. That default is
 * *inside* the project, which is precisely why production must set
 * `MONITOR_INSTALLER_PATH` — the same trade-off `RECORDINGS_DIR` and
 * `SCREENSHOTS_DIR` make, and the same warning in `.env.example`.
 *
 * Not exported. Nothing outside this file has a use for a server path, and a
 * value that cannot be imported cannot end up in a JSON response by accident.
 */
function installerPath(): string {
  const configured = process.env.MONITOR_INSTALLER_PATH?.trim();
  if (configured) return path.resolve(configured);

  return path.resolve(process.cwd(), ".data/downloads", monitorRelease().fileName);
}

/** Size and mtime, or null when there is no readable file at the configured path. */
export interface InstallerStatus {
  /** Bytes on disk. Null when the installer is missing. */
  sizeBytes: number | null;
  /** Last modified, ISO. Null when the installer is missing. */
  updatedAt: string | null;
}

/**
 * Is the installer actually there, and how big is it?
 *
 * `stat` rather than a cached number, because the file is placed on the server
 * by hand during deployment: a size baked into the code would be a claim about
 * a file this process has never looked at, and the first thing an agent would
 * notice is a button promising 77MB that 404s.
 *
 * A directory at the configured path counts as missing rather than as an error.
 * The caller's question is "can I send this to a browser", and the answer for a
 * directory is no.
 */
export async function installerStatus(): Promise<InstallerStatus> {
  try {
    /*
     * `turbopackIgnore` on the two filesystem calls in this file, here and in
     * `installerStream` below.
     *
     * The build's tracer sees a path it cannot evaluate statically — this one
     * is an absolute path from the environment, not a subdirectory of the
     * project — and responds by tracing the *whole* repository into the
     * standalone output in case something in it is what gets opened. That is a
     * much bigger release directory for a file that is deliberately not in the
     * repository at all: the installer lives in /var/lib, outside the release
     * tree, and no file inside the project is ever read here.
     *
     * The comment tells the tracer that, and changes nothing at runtime.
     */
    const info = await stat(/* turbopackIgnore: true */ installerPath());
    if (!info.isFile()) return { sizeBytes: null, updatedAt: null };
    return { sizeBytes: info.size, updatedAt: info.mtime.toISOString() };
  } catch {
    // ENOENT while nobody has uploaded an installer yet is the normal state of
    // a fresh box, not an incident. The route answers 404 and the panel says so
    // in a sentence; there is nothing here for a log to add.
    return { sizeBytes: null, updatedAt: null };
  }
}

/**
 * The installer as a web stream, ready to be a Response body.
 *
 * A stream and not a `readFile`, for the obvious reason at this size: buffering
 * 77MB into the heap to write it straight out to a socket would put a copy per
 * concurrent download in memory on a box with a 1GB `MemoryMax`. `Readable.toWeb`
 * also gives the runtime something it can cancel, so an agent who aborts a
 * download half way releases the file handle instead of reading the rest of the
 * file into nothing.
 */
export function installerStream(): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    // See the note on the same comment in `installerStatus` above.
    createReadStream(/* turbopackIgnore: true */ installerPath()),
  ) as ReadableStream<Uint8Array>;
}
