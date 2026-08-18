import { sniffImage as sniffJpeg } from "./screenshotRules";

/**
 * What counts as a demo image: the size limit, the accepted formats, and the
 * validation that enforces both from the bytes themselves.
 *
 * The third file of this shape in the application, after `recordingRules` and
 * `screenshotRules`, and deliberately the same shape: pure, no database, no
 * filesystem, bytes in and a description or a typed error out. It is a separate
 * file rather than an addition to `screenshotRules` because the two answer
 * different questions — a screenshot is always a JPEG produced by our own
 * desktop client, while a demo image is a file a human picked out of a folder,
 * which in practice means a PNG as often as a JPEG.
 *
 * ---------------------------------------------------------------------------
 * The declared type is never believed
 * ---------------------------------------------------------------------------
 * `file.type` and the filename are strings the browser wrote, and the type that
 * gets *stored* — and therefore later sent back as a `Content-Type` — is read
 * out of the file's own magic bytes here. That is the whole reason this
 * function exists: serving a caller-declared content type is the classic route
 * from "image upload" to stored XSS, and an HTML page renamed `logo.png` is the
 * exact input it is written against.
 */

/** An expected refusal, carrying the status the route should answer with. */
export class DemoImageError extends Error {
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
 * A screenshot of a website at retina width is 300KB–1.5MB as a PNG, so this is
 * comfortable headroom for the real cases and still refuses the accidental drag
 * of a video or a design file. The same ceiling `MAX_SCREENSHOT_BYTES` uses, and
 * well under the 40MB `proxyClientMaxBodySize` in `next.config.ts`, so the
 * refusal comes from here with a sentence rather than from the framework.
 */
export const MAX_DEMO_IMAGE_BYTES = 5 * 1024 * 1024;

/** Below this it is a truncated upload or a favicon, not a demo image. */
const MIN_DEMO_IMAGE_BYTES = 256;

/** Sane bounds. Refuses a 1×1 tracking pixel and a decompression bomb alike. */
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 16_384;

/**
 * The formats accepted, the extension each is stored under, and the content
 * type it is served as.
 *
 * One table, used by the sniffer, the storage key generator and the image
 * route. A format that is not in here cannot be stored, and — the half that
 * matters — cannot be served: the route looks the row's `image_format` up in
 * this map and refuses rather than echoing the column into a header. A header
 * the database can dictate is a header an attacker who reaches the database can
 * dictate.
 *
 * SVG is deliberately absent. An SVG is a document that can carry script, so
 * "an image format" is exactly what it is not for this purpose.
 */
export const DEMO_IMAGE_TYPES = {
  "image/jpeg": { extension: "jpg" },
  "image/png": { extension: "png" },
  "image/webp": { extension: "webp" },
} as const;

export type DemoImageType = keyof typeof DEMO_IMAGE_TYPES;

/** What the file picker offers, and what the upload copy tells the reader. */
export const DEMO_IMAGE_ACCEPT = Object.keys(DEMO_IMAGE_TYPES).join(",");
export const DEMO_IMAGE_EXTENSIONS = ["jpg", "png", "webp"] as const;

export function isDemoImageType(value: string): value is DemoImageType {
  return Object.prototype.hasOwnProperty.call(DEMO_IMAGE_TYPES, value);
}

export interface DemoImageFacts {
  type: DemoImageType;
  width: number;
  height: number;
}

/**
 * Identify the image from its own bytes and read its true dimensions.
 *
 * Three containers, each proved structurally rather than by its first four
 * bytes alone:
 *
 *   JPEG   delegated to `sniffImage` in `lib/screenshotRules.ts`, which walks
 *          the segment chain to the start-of-frame header. One JPEG parser in
 *          the application rather than two that can disagree.
 *   PNG    the 8-byte signature, then the first chunk must be `IHDR`, whose
 *          length must be 13 — so a file that merely starts with the signature
 *          is not enough. Width and height are the two big-endian uint32s that
 *          follow.
 *   WebP   `RIFF` … `WEBP`, then one of the three chunk layouts (`VP8 ` lossy,
 *          `VP8L` lossless, `VP8X` extended), each of which stores its
 *          dimensions differently and all three of which are read here.
 *
 * Returns null for anything else, including an SVG, a PDF and an HTML page with
 * an image extension.
 */
export function sniffDemoImage(bytes: Uint8Array): DemoImageFacts | null {
  const facts = sniffPng(bytes) ?? sniffWebp(bytes) ?? sniffJpegImage(bytes);
  if (!facts) return null;

  if (facts.width < MIN_DIMENSION || facts.height < MIN_DIMENSION) return null;
  if (facts.width > MAX_DIMENSION || facts.height > MAX_DIMENSION) return null;

  return facts;
}

/**
 * The screenshot sniffer, re-typed.
 *
 * It enforces its own 64px floor, which is stricter than this module's 32 —
 * that is fine and is left alone rather than parameterised: a demo image below
 * 64px is not a demo image either, and one JPEG parser with one set of rules is
 * worth more than a shared one with two.
 */
function sniffJpegImage(bytes: Uint8Array): DemoImageFacts | null {
  const jpeg = sniffJpeg(bytes);
  return jpeg ? { type: "image/jpeg", width: jpeg.width, height: jpeg.height } : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(bytes: Uint8Array): DemoImageFacts | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The first chunk must be IHDR, and IHDR is always exactly 13 bytes long.
  // Both are checked so that eight magic bytes glued onto something else is
  // refused rather than measured.
  if (view.getUint32(8) !== 13) return null;
  if (ascii(bytes, 12, 4) !== "IHDR") return null;

  return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
}

function sniffWebp(bytes: Uint8Array): DemoImageFacts | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = ascii(bytes, 12, 4);

  // Lossy: a VP8 keyframe header. The 3-byte start code 9D 01 2A sits after the
  // 3-byte frame tag, and the two 16-bit fields after it are 14 bits of
  // dimension plus 2 bits of scale.
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      type: "image/webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }

  // Lossless: a 1-byte signature then 14 bits of width and 14 of height, packed
  // little-endian across the next four bytes.
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const packed = view.getUint32(21, true);
    return {
      type: "image/webp",
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }

  // Extended: the canvas size as two 24-bit little-endian fields, minus one.
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { type: "image/webp", width, height };
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * Validate an uploaded demo image and return what is true about it.
 *
 * Order matters, as it does in the two sibling validators: size before content,
 * so the commonest mistake produces the message that names it and so a 200MB
 * body is refused without being walked.
 */
export function validateDemoImage(bytes: Uint8Array): DemoImageFacts {
  if (bytes.byteLength === 0) {
    throw new DemoImageError("empty_file", "That file is empty.", 400);
  }
  if (bytes.byteLength > MAX_DEMO_IMAGE_BYTES) {
    throw new DemoImageError(
      "too_large",
      `That image is over the ${Math.round(MAX_DEMO_IMAGE_BYTES / 1024 / 1024)}MB limit.`,
      413,
    );
  }
  if (bytes.byteLength < MIN_DEMO_IMAGE_BYTES) {
    throw new DemoImageError(
      "invalid_image",
      "That file is too small to be an image.",
      422,
    );
  }

  const facts = sniffDemoImage(bytes);
  if (!facts) {
    throw new DemoImageError(
      "unsupported_type",
      `Upload a ${DEMO_IMAGE_EXTENSIONS.join(", ")} image. The file you chose is not one.`,
      415,
    );
  }

  return facts;
}
