/**
 * The rules for the two fields Demo Websites adds to a lead: the link and the
 * image's shape on the wire.
 *
 * The same split `lib/recordingRules.ts` and `lib/screenshotRules.ts` keep from
 * the modules that use them, and for the same reason — nothing here touches the
 * database, the filesystem or `next/headers`, so the cell in the browser and
 * the handler on the server enforce one set of rules instead of two that drift.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately *not* here
 * ---------------------------------------------------------------------------
 * Statuses, page sizes, sort keys, search parsing, filters. Demo Websites is
 * the worklist looked at through a second view, so all of those already exist
 * in `lib/leadQuery.ts` and are used unchanged. An earlier version of this file
 * had its own copies of every one of them; they were a parallel implementation
 * of the lead list, and deleting them is most of what the correction was.
 *
 * A demo has no status of its own either. The status the demo screen shows is
 * the lead's `CallStatus`, read from `leads` on the request that draws it.
 */

/** An expected refusal, carrying the status the route should answer with. */
export class DemoWebsiteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The longest a demo link may be.
 *
 * Not a security boundary — Prisma parameterises the value, so a long string is
 * a long string and not a query — it is what stops one row from being a
 * megabyte of pasted text that then has to be rendered in a table cell on every
 * page load.
 */
export const MAX_URL_LENGTH = 2048;

// --- the demo link -----------------------------------------------------------

/**
 * The only two protocols a demo link may use.
 *
 * A stored URL is rendered as an `<a href>` and clicked by a human, which is
 * exactly the shape of the oldest stored-XSS trick there is: `javascript:` in a
 * field somebody assumed was a website. `data:` is the same attack wearing a
 * different hat, and `file:` points a reader at their own disk. The check is a
 * whitelist rather than a blacklist because a blacklist is a list of the
 * schemes somebody happened to think of.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate and canonicalise a demo link.
 *
 * Run **server-side**, before the value is stored, and again by nothing: what
 * is in the column is what was validated, so the renderer does not have to
 * re-decide whether a link is safe every time it draws one. (The cell runs the
 * same function in the browser, to say "that is not a web address" before a
 * round trip. That copy is a convenience and is not what protects anything.)
 *
 * What it refuses, and why each one is here:
 *
 *   - anything not http/https, per {@link ALLOWED_PROTOCOLS};
 *   - a URL carrying credentials (`https://user:pass@host`), which is a
 *     phishing shape and has no business in a demo link;
 *   - a hostname that is missing, a bare dot, or has no dot in it at all;
 *   - anything beginning `//`, which is a protocol-relative URL: a browser
 *     reads `//evil.com` as an absolute address on whatever scheme the current
 *     page is using. It is refused rather than repaired even though repairing
 *     it would be easy, because "looks relative, resolves absolute" is the
 *     shape that gets past a reviewer — and an administrator who meant
 *     `example.com` can simply type that;
 *   - anything over {@link MAX_URL_LENGTH};
 *   - control characters, which can smuggle a line break into anything that
 *     later writes the value into a header or a log line.
 *
 * A bare `example.com` is *accepted* and normalised to `https://example.com/`.
 * That is a deliberate kindness rather than a hole: the value is parsed as a
 * URL either way, and the alternative is refusing the thing an agent will type
 * nine times out of ten. Nothing is guessed about a value that already carries
 * a scheme — `javascript:alert(1)` is refused, not rewritten — and nothing is
 * guessed about one that begins with a slash either.
 *
 * **This is not a redirector.** The portal never issues a `Location:` to a
 * stored demo link and never fetches one server-side; it renders an anchor with
 * `target="_blank" rel="noopener noreferrer"` and the reader's own browser goes
 * there. There is no open redirect to create because there is no redirect.
 */
export function normaliseDemoUrl(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";

  if (value === "") {
    throw new DemoWebsiteError("invalid_url", "Enter the demo link.", 400);
  }
  if (value.length > MAX_URL_LENGTH) {
    throw new DemoWebsiteError(
      "invalid_url",
      `That demo link is too long (limit ${MAX_URL_LENGTH} characters).`,
      400,
    );
  }
  if (hasControlCharacter(value)) {
    throw new DemoWebsiteError(
      "invalid_url",
      "That demo link contains characters that are not allowed in a web address.",
      400,
    );
  }

  if (value.startsWith("//")) {
    throw new DemoWebsiteError(
      "invalid_url",
      "Demo links must start with http:// or https://.",
      400,
    );
  }

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new DemoWebsiteError(
      "invalid_url",
      "That is not a valid web address. Use a link like https://example-demo.com.",
      400,
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new DemoWebsiteError(
      "invalid_url",
      "Demo links must start with http:// or https://.",
      400,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new DemoWebsiteError(
      "invalid_url",
      "Demo links must not contain a username or password.",
      400,
    );
  }
  if (url.hostname === "" || url.hostname === "." || !url.hostname.includes(".")) {
    // A dotless host is either a typo or an intranet name that will not resolve
    // for the client the demo is being shown to, which is the same problem.
    throw new DemoWebsiteError(
      "invalid_url",
      "That demo link has no domain name. Use a link like https://example-demo.com.",
      400,
    );
  }

  const href = url.toString();
  if (href.length > MAX_URL_LENGTH) {
    throw new DemoWebsiteError(
      "invalid_url",
      `That demo link is too long (limit ${MAX_URL_LENGTH} characters).`,
      400,
    );
  }

  return href;
}

/**
 * The same rule, as a question rather than an assertion.
 *
 * For the cell, which wants to grey out a Save button rather than throw.
 */
export function isValidDemoUrl(raw: string): boolean {
  try {
    normaliseDemoUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** CR, LF, NUL and friends — the same rule `safeCallbackUrl` applies. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// --- the demo comments -------------------------------------------------------

/**
 * The longest the demo comments may be.
 *
 * The same kind of limit {@link MAX_URL_LENGTH} is and for the same reason —
 * not a security boundary, but the thing that stops one row from being a
 * megabyte of pasted text. Generous, because this is a notes field and being
 * cut off mid-sentence while describing a demo is the worse failure.
 */
export const MAX_COMMENTS_LENGTH = 4000;

/**
 * Validate and normalise the demo comments.
 *
 * `null` and a string that is empty once trimmed both mean "there are no
 * comments", and both are stored as NULL — so the column has one empty value
 * rather than two, and "has comments" is `IS NOT NULL` everywhere.
 *
 * Unlike a URL this is never parsed, never resolved and never rendered as
 * anything but text: React escapes it on the way out, so there is nothing to
 * strip here. Only the two things that are genuinely not text are refused —
 * a non-string, and anything over the limit. NUL is dropped rather than
 * refused, because it is the one character Postgres will not accept in a text
 * value and a person who pasted one did not type it.
 */
export function normaliseDemoComments(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw !== "string") {
    throw new DemoWebsiteError("invalid_comments", "The demo comments must be text.", 400);
  }

  const value = raw.replace(/ /g, "").trim();
  if (value === "") return null;

  if (value.length > MAX_COMMENTS_LENGTH) {
    throw new DemoWebsiteError(
      "invalid_comments",
      `Those demo comments are too long (limit ${MAX_COMMENTS_LENGTH} characters).`,
      400,
    );
  }

  return value;
}

/** `https://example-demo.com/menu` -> `example-demo.com` for a table cell. */
export function demoUrlHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

// --- what the browser is told ------------------------------------------------

/** The image, as the browser sees it: a size and a shape, never a path. */
export interface DemoImageMeta {
  width: number;
  height: number;
  fileSize: number;
  /** Changes when the image is replaced, so an `<img src>` can bust its cache. */
  updatedAt: string;
}

/**
 * One lead's demo metadata.
 *
 * Deliberately **only** the demo's own fields — the two links, the comments
 * and the image's shape — and nothing about the lead. The
 * name, the phone, the status and the notes travel in the `Lead` beside this,
 * read from `leads` on the same request — see the note on the `DemoWebsite`
 * model in `schema.prisma` for why they must never be copied in here.
 *
 * Also deliberately **no storage key and no filesystem detail of any kind**.
 * The image is reached by `GET /api/leads/:id/demo/image`, which reads the key
 * off the row server-side; nothing in this payload names a file.
 *
 * A lead with no demo row has no `DemoSummary` at all — the map simply has no
 * entry for it — which is what "the lead still appears, with both cells empty"
 * looks like on the wire.
 */
export interface DemoSummary {
  leadId: string;
  /** Demo link 1. Independent of {@link DemoSummary.demoUrl2}. */
  demoUrl: string | null;
  /** Demo link 2. A lead may have this one and not the first. */
  demoUrl2: string | null;
  /** Free text about the demo. Never the lead's call notes — a different
   *  column in a different table behind a different permission. */
  demoComments: string | null;
  image: DemoImageMeta | null;
  updatedAt: string;
}

/**
 * Which demo link a control is editing.
 *
 * The two are the same field twice over — same validator, same endpoint, same
 * cell component — so they are told apart by this rather than by two copies of
 * the code that differ only in a property name.
 */
export type DemoLinkField = "demoUrl" | "demoUrl2";

/** What each link is called on screen. One place, so the two never disagree. */
export const DEMO_LINK_LABELS: Record<DemoLinkField, string> = {
  demoUrl: "Demo link 1",
  demoUrl2: "Demo link 2",
};

/** Demo metadata for a page of leads, keyed by lead id. Sparse by design. */
export type DemoSummaryMap = Record<string, DemoSummary>;
