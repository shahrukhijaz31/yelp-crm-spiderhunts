/**
 * What counts as a call recording: the limits, the accepted formats, and the
 * shape the browser is given.
 *
 * Split out from `lib/recordings.ts` for one reason — that file imports Prisma
 * and the storage layer, so it can never be reached from a client component,
 * and the upload UI needs the size limit and the format list to say the same
 * thing the server enforces. A copy in the component is a copy that drifts:
 * the day the limit moves, the agent is told 25MB by a button and 40MB by a
 * refusal. Nothing here touches the database, the filesystem or `next/headers`,
 * so it is safe on both sides of the wire.
 *
 * The validation itself lives here too, not just the constants. It is pure —
 * bytes in, content type or an error out — and putting it beside the limits it
 * enforces is what keeps them honest about each other.
 */

/**
 * Accepted content types, and the extensions a browser is likely to attach to
 * each. Both are checked, and then the bytes themselves are sniffed — a
 * `Content-Type` in a multipart part is just a string the client wrote.
 */
export const ACCEPTED_AUDIO_TYPES: Record<string, readonly string[]> = {
  "audio/mpeg": ["mp3", "mpeg", "mpga"],
  "audio/wav": ["wav", "wave"],
  "audio/mp4": ["m4a", "mp4", "m4b"],
  "audio/webm": ["webm", "weba"],
  "audio/ogg": ["ogg", "oga", "opus"],
};

/** What the file picker offers, and what the copy tells the agent. */
export const ACCEPTED_EXTENSIONS = ["mp3", "wav", "m4a", "webm", "ogg"] as const;

/**
 * 25MB.
 *
 * A phone call at a normal mobile-recorder bitrate (~64kbps mono MP3) is about
 * 0.5MB a minute, so this is a comfortable hour and a half — longer than any
 * call this portal is about — while staying small enough that an accidental
 * drag of a video file is refused rather than filling the disk. nginx is
 * configured a little above it so the refusal comes from here, with a message,
 * rather than from nginx's error page.
 */
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

/** Nothing shorter than this can be audio; it is a mis-drop or an empty file. */
const MIN_RECORDING_BYTES = 512;

/** 4 hours. A duration past this is a broken read, not a phone call. */
const MAX_DURATION_SECONDS = 4 * 60 * 60;

/** An expected refusal, carrying the status the route should answer with. */
export class RecordingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Identify the audio from its first bytes.
 *
 * This is the type that gets stored and later sent as `Content-Type`, so it is
 * derived from the file itself rather than from what the browser claimed.
 * Trusting the claim would let a caller store an HTML file as `audio/mpeg` and
 * then get it served back with a content type the browser would render — the
 * classic route from "file upload" to stored XSS. Serving only sniffed audio
 * types (alongside the `Content-Disposition` and `X-Content-Type-Options` the
 * stream route sets) closes it.
 *
 * Returns null when the bytes are not one of the accepted containers.
 */
export function sniffAudioType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));

  // MP3: an ID3v2 tag, or a raw frame sync (11 set bits).
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";

  // WAV is RIFF with a WAVE form type — RIFF alone is also AVI and others.
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";

  // M4A is an ISO base-media file: a `ftyp` box at offset 4. The brand is not
  // checked, because audio-only mp4 ships as `M4A `, `mp42` and `isom` alike.
  if (ascii(4, 4) === "ftyp") return "audio/mp4";

  // WebM and Matroska share the EBML magic; browser-recorded audio is WebM.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm";
  }

  if (ascii(0, 4) === "OggS") return "audio/ogg";

  return null;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Validate an upload and return the type to store it as.
 *
 * Order matters: size is checked before the bytes are looked at, and the
 * declared type before the sniff, so the commonest mistakes produce the
 * message that names them.
 */
export function validateUpload(
  fileName: string,
  declaredType: string,
  bytes: Uint8Array,
): string {
  if (bytes.byteLength === 0) {
    throw new RecordingError("empty_file", "That file is empty.", 400);
  }
  if (bytes.byteLength > MAX_RECORDING_BYTES) {
    throw new RecordingError(
      "too_large",
      `That recording is over the ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)}MB limit.`,
      413,
    );
  }
  if (bytes.byteLength < MIN_RECORDING_BYTES) {
    throw new RecordingError(
      "not_audio",
      "That file is too small to be a call recording.",
      400,
    );
  }

  const extension = extensionOf(fileName);
  const declared = declaredType.split(";")[0]?.trim().toLowerCase() ?? "";

  // The declared type is only ever used to refuse — never to decide what is
  // stored. A blank type (some file pickers send none) falls through to the
  // extension and then to the sniff, which is the authority regardless.
  const declaredIsAudio = declared === "" || declared in ACCEPTED_AUDIO_TYPES;
  const extensionIsAudio =
    extension === "" ||
    Object.values(ACCEPTED_AUDIO_TYPES).some((list) => list.includes(extension));

  if (!declaredIsAudio || !extensionIsAudio) {
    throw new RecordingError(
      "unsupported_type",
      `Upload an audio file — ${ACCEPTED_EXTENSIONS.join(", ")}.`,
      415,
    );
  }

  const sniffed = sniffAudioType(bytes);
  if (!sniffed) {
    throw new RecordingError(
      "unsupported_type",
      `That does not look like an audio file. Accepted formats: ${ACCEPTED_EXTENSIONS.join(", ")}.`,
      415,
    );
  }

  return sniffed;
}

/** Clamp the browser-reported duration, or drop it. Display only. */
export function normaliseDuration(raw: unknown): number | null {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value), MAX_DURATION_SECONDS);
}

/**
 * The recording as it is sent to the browser.
 *
 * Deliberately does not include `storageKey`: the browser addresses audio by
 * meeting through the stream route, never by storage path, so the key has no
 * reason to leave the server and every reason not to.
 */
export interface RecordingSummary {
  id: string;
  leadId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  durationSeconds: number | null;
  /** ISO timestamp; the UI formats it in the viewer's own timezone. */
  uploadedAt: string;
  uploadedBy: { id: string; name: string };
  /** Whether *this* caller may replace or delete it. Mirrors the server rule. */
  canManage: boolean;
}
