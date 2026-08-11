/**
 * What counts as a screenshot: the limits, the accepted format, and the
 * validation that enforces both.
 *
 * The same split `lib/recordingRules.ts` keeps from `lib/recordings.ts`, and
 * for the same reason — nothing here touches the database, the filesystem or
 * `next/headers`, so the constants and the checks can be read from anywhere.
 *
 * The validation is pure: bytes in, a description or a typed error out.
 */

/** An expected refusal, carrying the status the route should answer with. */
export class ScreenshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * 5MB.
 *
 * A 1920×1080 desktop at the client's quality setting measures 160–180KB, and
 * a 4K panel would be roughly a megabyte, so this is generous headroom for
 * higher-resolution workstations and for a future multi-monitor composite —
 * while still refusing anything that is obviously not a screenshot. Deliberately
 * not "large enough for anything": these arrive several times an hour per agent
 * and an unnecessarily high ceiling is a disk-filling misfeature, not safety.
 *
 * Well under the 40MB `proxyClientMaxBodySize` in `next.config.ts`, so the
 * refusal comes from here with a message rather than from the framework.
 */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Nothing smaller than this is a real screen capture; it is a truncated body. */
const MIN_SCREENSHOT_BYTES = 1024;

/** The only format accepted today. See `sniffImageType`. */
export const ACCEPTED_IMAGE_TYPE = "image/jpeg";

/**
 * How far `capturedAt` may sit from the server's own clock.
 *
 * A workstation's clock is not authoritative and cannot be made so, but a
 * timestamp that disagrees by days is either a broken machine or a client
 * trying to file a screenshot into last week. Anything outside the window is
 * replaced with the server's time rather than refused — the screenshot is
 * genuine, only its self-reported instant is not — and the discrepancy stays
 * visible because `createdAt` records when the server actually received it.
 */
const CLOCK_SKEW_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** Sane bounds for a desktop. Refuses a 1×1 pixel "screenshot". */
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 16_384;

export interface ImageFacts {
  type: typeof ACCEPTED_IMAGE_TYPE;
  width: number;
  height: number;
}

/**
 * Identify the image from its own bytes and read its real dimensions.
 *
 * This is the whole answer to "do not trust the extension, and verify the
 * content is actually an image". The client's declared content type, its
 * filename and its claimed resolution are all just strings it wrote; a JPEG,
 * by contrast, has to start `FF D8 FF`, end `FF D9`, and carry a start-of-frame
 * segment whose header states the true height and width. Walking to that
 * segment proves the file is structurally a JPEG rather than an HTML page with
 * a `.jpg` on the end, and yields the dimensions that get stored — so a client
 * cannot claim 1920×1080 while uploading something else.
 *
 * Returns null for anything that is not a well-formed JPEG.
 */
export function sniffImage(bytes: Uint8Array): ImageFacts | null {
  if (bytes.length < 4) return null;

  // SOI, and the first marker of the segment that must follow it.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;

  // EOI. A truncated upload — the commonest real failure — stops here rather
  // than being stored as a file that no viewer will open.
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;

  let offset = 2;

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1]!;

    // Padding, SOI, and the restart markers carry no length field.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    // Start of frame. Every SOFn except DHT (C4), JPG (C8) and DAC (CC) has the
    // same header layout: length, precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);

      if (width < MIN_DIMENSION || height < MIN_DIMENSION) return null;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;

      return { type: ACCEPTED_IMAGE_TYPE, width, height };
    }

    // Start of scan: the entropy-coded data begins and there is no further
    // segment header to walk. A JPEG with no SOF before its SOS is malformed.
    if (marker === 0xda) return null;

    if (offset + 4 > bytes.length) return null;
    const segmentLength = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }

  return null;
}

/**
 * Validate an uploaded screenshot and return what is true about it.
 *
 * Order matters: size before content, so the commonest mistake produces the
 * message that names it, and so a 200MB body is refused without being walked.
 */
export function validateScreenshot(bytes: Uint8Array): ImageFacts {
  if (bytes.byteLength === 0) {
    throw new ScreenshotError("empty_file", "The uploaded file is empty.", 400);
  }
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new ScreenshotError(
      "too_large",
      `That screenshot is over the ${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)}MB limit.`,
      413,
    );
  }
  if (bytes.byteLength < MIN_SCREENSHOT_BYTES) {
    throw new ScreenshotError(
      "invalid_image",
      "That file is too small to be a screenshot.",
      422,
    );
  }

  const facts = sniffImage(bytes);
  if (!facts) {
    throw new ScreenshotError(
      "unsupported_type",
      "The upload is not a valid JPEG image.",
      415,
    );
  }

  return facts;
}

/**
 * The client's capture time, if it is believable; otherwise the server's.
 *
 * Never throws — see {@link CLOCK_SKEW_TOLERANCE_MS}. A missing or unparseable
 * value falls back the same way a wildly wrong one does.
 */
export function resolveCapturedAt(raw: unknown, now = new Date()): Date {
  if (typeof raw !== "string") return now;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return now;

  if (Math.abs(parsed.getTime() - now.getTime()) > CLOCK_SKEW_TOLERANCE_MS) return now;

  return parsed;
}

/**
 * The workstation's display identifier, as an opaque label.
 *
 * Never used to select, address or build anything — it is stored so an
 * administrator can tell one monitor from another — so the only rules are that
 * it is short and contains nothing that could be mistaken for markup or a path.
 */
export function normaliseDisplayId(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}
