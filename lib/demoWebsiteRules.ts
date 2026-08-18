/**
 * What counts as a demo website: the statuses, the field limits, the URL rule,
 * and the shape one takes on its way to the browser.
 *
 * The same split `lib/recordingRules.ts` and `lib/screenshotRules.ts` keep from
 * the modules that use them, and for the same reason — nothing here touches the
 * database, the filesystem or `next/headers`, so the form in the browser and
 * the handler on the server can enforce one set of rules instead of two that
 * drift. Every function is pure: values in, a normalised value or a typed error
 * out.
 *
 * The image rules live next door in `lib/demoImageRules.ts`, which is the same
 * idea again for bytes.
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

// --- status ------------------------------------------------------------------

/**
 * The four states, in the order the filter offers them.
 *
 * Mirrors the `DemoWebsiteStatus` enum in `schema.prisma` exactly, including
 * the order — a Postgres enum's declaration order is its sort order, so the two
 * lists have to agree or a later `prisma migrate diff` sees a change that is
 * not one. That is the same contract `CALL_STATUSES` keeps with `CallStatus`.
 */
export const DEMO_WEBSITE_STATUSES = ["draft", "active", "presented", "archived"] as const;

export type DemoWebsiteStatus = (typeof DEMO_WEBSITE_STATUSES)[number];

/** Human copy, kept out of the database so changing a word is not a migration. */
export const DEMO_WEBSITE_STATUS_LABELS: Record<DemoWebsiteStatus, string> = {
  draft: "Draft",
  active: "Active",
  presented: "Presented",
  archived: "Archived",
};

/**
 * The chip colour per status, as the token names the rest of the portal uses.
 *
 * Only `active` gets the success tone — it is the state that means "ready to
 * put in front of a client", and it is the one an agent scans a list for.
 * Archived is deliberately the quietest thing on the screen.
 */
export const DEMO_WEBSITE_STATUS_TONES: Record<DemoWebsiteStatus, string> = {
  draft: "st-steel",
  active: "success",
  presented: "accent",
  archived: "st-steel",
};

export function isDemoWebsiteStatus(value: unknown): value is DemoWebsiteStatus {
  return (
    typeof value === "string" && (DEMO_WEBSITE_STATUSES as readonly string[]).includes(value)
  );
}

/** New rows default to Active: most demos are added because they are ready. */
export const DEFAULT_DEMO_WEBSITE_STATUS: DemoWebsiteStatus = "active";

// --- field limits ------------------------------------------------------------

/**
 * Caps, in characters.
 *
 * These are not security boundaries — Prisma parameterises every value, so a
 * long string is a long string and not a query — they are what stops one row
 * from being a megabyte of pasted text that then has to be rendered in a table
 * cell on every page load. The search cap is the one that matters most and is
 * the same 200 the worklist uses, for the reason `lib/leadQuery.ts` gives.
 */
export const MAX_NAME_LENGTH = 160;
export const MAX_CLIENT_LENGTH = 160;
export const MAX_URL_LENGTH = 2048;
export const MAX_PHONE_LENGTH = 40;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_SEARCH_LENGTH = 200;

// --- the demo link -----------------------------------------------------------

/**
 * The only two protocols a demo link may use.
 *
 * A stored URL is rendered as an `<a href>` and clicked by a human, which is
 * exactly the shape of the oldest stored-XSS trick there is: `javascript:` in
 * a field somebody assumed was a website. `data:` is the same attack wearing a
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
 * re-decide whether a link is safe every time it draws one. (The form runs the
 * same function in the browser, to say "that is not a web address" before a
 * round trip. That copy is a convenience and is not what protects anything.)
 *
 * What it refuses, and why each one is here:
 *
 *   - anything not http/https, per {@link ALLOWED_PROTOCOLS};
 *   - a URL carrying credentials (`https://user:pass@host`), which is a
 *     phishing shape and has no business in a demo link;
 *   - a hostname that is missing or is a bare dot;
 *   - anything over {@link MAX_URL_LENGTH};
 *   - control characters, which can smuggle a line break into anything that
 *     later writes the value into a header or a log line.
 *
 * A bare `example.com` is *accepted* and normalised to `https://example.com/`.
 * That is a deliberate kindness rather than a hole: the value is parsed as a
 * URL either way, and the alternative is refusing the thing an administrator
 * will type nine times out of ten. Nothing is guessed about a value that
 * already carries a scheme — `javascript:alert(1)` is refused, not rewritten.
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

  // A scheme-relative `//example.com` is a URL to a browser but has no protocol
  // of its own, so it is treated as the schemeless case rather than parsed —
  // otherwise it would inherit whatever base a future caller happened to pass.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
    ? value
    : `https://${value.replace(/^\/+/, "")}`;

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

/** CR, LF, NUL and friends — the same rule `safeCallbackUrl` applies. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `https://example-demo.com/menu` -> `example-demo.com` for a table cell. */
export function demoUrlHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

// --- the rest of the fields --------------------------------------------------

function text(raw: unknown, limit: number): string {
  return typeof raw === "string" ? raw.trim().slice(0, limit) : "";
}

/**
 * A phone number, or null.
 *
 * Not validated as a phone number, on purpose. This portal already holds leads
 * from several countries in whatever shape the scraper found them, and a
 * regular expression that decides what a phone number looks like is a
 * regular expression that refuses somebody's real number. Length-capped and
 * stripped of control characters, and that is all.
 */
export function normalisePhone(raw: unknown): string | null {
  const value = text(raw, MAX_PHONE_LENGTH).replace(/[ -]/g, "");
  return value === "" ? null : value;
}

/** An email address, or null. The same shallow check `createUser` uses. */
export function normaliseEmail(raw: unknown): string | null {
  const value = text(raw, MAX_EMAIL_LENGTH).toLowerCase();
  if (value === "") return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new DemoWebsiteError("invalid_email", "Enter a valid email address.", 400);
  }
  return value;
}

export function normaliseName(raw: unknown): string {
  const value = text(raw, MAX_NAME_LENGTH);
  if (value.length < 2) {
    throw new DemoWebsiteError("invalid_name", "Give the demo website a name.", 400);
  }
  return value;
}

export function normaliseClientName(raw: unknown): string {
  return text(raw, MAX_CLIENT_LENGTH);
}

export function normaliseNotes(raw: unknown): string {
  return text(raw, MAX_NOTES_LENGTH);
}

export function normaliseStatus(raw: unknown): DemoWebsiteStatus {
  if (!isDemoWebsiteStatus(raw)) {
    throw new DemoWebsiteError(
      "invalid_status",
      `Status must be one of: ${DEMO_WEBSITE_STATUSES.join(", ")}.`,
      400,
    );
  }
  return raw;
}

// --- what a row looks like on the wire ---------------------------------------

/** The image, as the browser sees it: a size and a shape, never a path. */
export interface DemoWebsiteImageMeta {
  width: number;
  height: number;
  fileSize: number;
  /** Changes when the image is replaced, so an `<img src>` can bust its cache. */
  updatedAt: string;
}

/**
 * One demo website, serialised.
 *
 * Deliberately **no storage key and no filesystem detail of any kind**. The
 * image is reached by `GET /api/demo-websites/:id/image`, which reads the key
 * off the row server-side; nothing in this payload names a file, so there is
 * nothing in the browser's memory for a bug or a screenshot to leak.
 */
export interface DemoWebsiteCard {
  id: string;
  name: string;
  clientName: string;
  demoUrl: string;
  phone: string | null;
  email: string | null;
  status: DemoWebsiteStatus;
  notes: string;
  image: DemoWebsiteImageMeta | null;
  createdAt: string;
  updatedAt: string;
}

// --- the list query ----------------------------------------------------------

/** The page sizes the selector offers. Nothing else is accepted. */
export const DEMO_PAGE_SIZES = [10, 20, 50, 100] as const;

export type DemoPageSize = (typeof DEMO_PAGE_SIZES)[number];

export const DEFAULT_DEMO_PAGE_SIZE: DemoPageSize = 20;

/**
 * The columns a header click can sort by.
 *
 * A closed set, not a column name passed through from the browser: this value
 * ends up choosing an `orderBy`, and the mapping from key to column is held in
 * `lib/demoWebsites.ts` rather than being built from the string. Nothing
 * outside this list can reach a query.
 */
export const DEMO_SORT_KEYS = ["created", "updated", "name", "client", "status"] as const;

export type DemoSortKey = (typeof DEMO_SORT_KEYS)[number];

export const DEMO_SORT_DIRECTIONS = ["asc", "desc"] as const;

export type DemoSortDirection = (typeof DEMO_SORT_DIRECTIONS)[number];

/** Newest first: the list is a working set, and the newest demo is the news. */
export const DEFAULT_DEMO_SORT: { key: DemoSortKey; direction: DemoSortDirection } = {
  key: "created",
  direction: "desc",
};

export interface DemoWebsiteQuery {
  /** Free text over name, client, URL, phone and email. Length-capped. */
  search: string;
  /** `null` is "any status" — the absence of a filter, not a fifth status. */
  status: DemoWebsiteStatus | null;
  sort: { key: DemoSortKey; direction: DemoSortDirection };
  page: number;
  pageSize: DemoPageSize;
}

export interface DemoWebsiteListMeta {
  page: number;
  pageSize: number;
  /** Rows matching the search and the status filter, not the size of the table. */
  total: number;
  totalPages: number;
}

export interface DemoWebsitePayload {
  demoWebsites: DemoWebsiteCard[];
  meta: DemoWebsiteListMeta;
  /** Counts per status across the whole table, unfiltered — the filter badges. */
  statusCounts: Record<DemoWebsiteStatus, number>;
}

export function defaultDemoWebsiteQuery(): DemoWebsiteQuery {
  return {
    search: "",
    status: null,
    sort: { ...DEFAULT_DEMO_SORT },
    page: 1,
    pageSize: DEFAULT_DEMO_PAGE_SIZE,
  };
}

/**
 * A query string as a validated {@link DemoWebsiteQuery}.
 *
 * Treats its input as hostile, exactly as `parseLeadSearchParams` does: every
 * value is checked against the closed set the UI offers, and anything else is
 * replaced with the default rather than passed along. `?pageSize=100000` is a
 * request for twenty rows.
 *
 * Nothing parsed here is ever consulted to decide *whether* the caller may see
 * anything — that decision was made by `apiModule()` before this runs — so
 * every one of these is safe as an arbitrary string, and a stale bookmark is
 * clamped rather than 400'd.
 */
export function parseDemoWebsiteParams(params: URLSearchParams): DemoWebsiteQuery {
  const status = params.get("status");

  return {
    search: (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
    status: isDemoWebsiteStatus(status) ? status : null,
    sort: {
      key: readOneOf(params.get("sort"), DEMO_SORT_KEYS, DEFAULT_DEMO_SORT.key),
      direction: readOneOf(
        params.get("dir"),
        DEMO_SORT_DIRECTIONS,
        DEFAULT_DEMO_SORT.direction,
      ),
    },
    page: readDemoPage(params.get("page")),
    pageSize: readDemoPageSize(params.get("pageSize")),
  };
}

/** The query as a `URLSearchParams`. Defaults omitted, so the first ask is short. */
export function buildDemoWebsiteParams(query: DemoWebsiteQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.search.trim() !== "") params.set("q", query.search.trim().slice(0, MAX_SEARCH_LENGTH));
  if (query.status) params.set("status", query.status);
  if (query.sort.key !== DEFAULT_DEMO_SORT.key || query.sort.direction !== DEFAULT_DEMO_SORT.direction) {
    params.set("sort", query.sort.key);
    params.set("dir", query.sort.direction);
  }
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));

  return params;
}

export function readDemoPage(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
}

export function readDemoPageSize(value: string | null | undefined): DemoPageSize {
  const parsed = Number(value);
  return (DEMO_PAGE_SIZES as readonly number[]).includes(parsed)
    ? (parsed as DemoPageSize)
    : DEFAULT_DEMO_PAGE_SIZE;
}

function readOneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// --- display -----------------------------------------------------------------

/**
 * `2026-08-18T14:02:11Z` -> `18 Aug 2026, 14:02`.
 *
 * `en-GB` explicitly rather than the reader's locale, matching
 * `describeLastLogin` in the user list: the portal is one workspace with one
 * date order, and a table where two administrators read the same column
 * differently is a table that causes an argument.
 */
export function formatDemoDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** The same instant, short, for a table cell: `18 Aug 2026`. */
export function formatDemoDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
