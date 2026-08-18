/**
 * An agent's own screenshots — the shapes and the cursor, with no database in
 * them.
 *
 * Kept apart from `screenshotViewerRules.ts` on purpose. That module describes
 * the administrator's viewer, whose whole job is to be pointed at somebody:
 * `ScreenshotQuery` carries a `userId` and a `workSessionId`, both read from
 * the URL, because an administrator is entitled to ask about anyone. The query
 * here carries neither, and there is nowhere in it for one to be put.
 *
 * That is the difference the security of this feature rests on. The agent-side
 * request object cannot name a person, so the agent-side handler cannot be
 * asked about one, so there is no filter to validate and no branch to get
 * wrong. The subject is supplied by the route from the session row and travels
 * as a separate argument that never touches the request (see
 * `lib/myScreenshots.ts`).
 *
 * Formatting is imported from the admin module rather than copied — those are
 * pure string functions with no policy in them, and two clocks that disagree
 * about how to write a time is a bug waiting for somebody to compare screens.
 */

/** How many cards a page holds. A grid of 24 is four full rows at six across. */
export const MY_SCREENSHOT_PAGE_SIZE = 24;

/**
 * The ceiling on `?limit=`.
 *
 * A caller may ask for fewer or more than the default and is clamped to this
 * either way. It exists so that "do not fetch every screenshot at once" is a
 * property of the endpoint rather than of the component that happens to call
 * it — a hand-written request for `?limit=100000` gets 48 rows.
 */
export const MY_SCREENSHOT_MAX_PAGE_SIZE = 48;

export function readMyScreenshotLimit(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return MY_SCREENSHOT_PAGE_SIZE;
  return Math.min(parsed, MY_SCREENSHOT_MAX_PAGE_SIZE);
}

/* -------------------------------------------------------------------------- */
/* The cursor                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where the last page stopped: an instant and an id.
 *
 * Keyset rather than `skip`/`take`, because this list is append-only at the
 * head — a capture arriving while somebody is scrolling shifts every offset
 * down by one and makes an offset-paged reader see the same card twice. The
 * pair is (capturedAt, id) because captures are not unique in time and the sort
 * has to be total, which is also why the index `@@index([userId, capturedAt])`
 * is the one this reads through.
 *
 * **It is not a capability.** The cursor names a position in a list that has
 * already been scoped to the caller; it is not consulted about whose list. A
 * cursor lifted from another agent's browser, or one typed by hand, moves this
 * caller's own window and returns this caller's own rows — see the where clause
 * in `lib/myScreenshots.ts`, which takes the user id from the session either
 * way. Base64 here is compactness in a query string, never concealment.
 */
export interface MyScreenshotCursor {
  capturedAt: Date;
  id: string;
}

export function encodeMyScreenshotCursor(cursor: MyScreenshotCursor): string {
  return Buffer.from(`${cursor.capturedAt.getTime()}:${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * Read a cursor, or null.
 *
 * Null for anything malformed rather than a 400: the worst a nonsense cursor
 * can do is start the list from the beginning, and a gallery that errors
 * because a stale link was reopened is worse than one that shows the first
 * page. The id is checked against the same character class the admin viewer
 * uses for ids, so nothing exotic reaches the query builder even though a cuid
 * could never be a path here.
 */
export function decodeMyScreenshotCursor(
  value: string | null | undefined,
): MyScreenshotCursor | null {
  if (!value) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 1) return null;

  const millis = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isSafeInteger(millis) || millis <= 0) return null;
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return null;

  return { capturedAt: new Date(millis), id };
}

/* -------------------------------------------------------------------------- */
/* What crosses to the browser                                                */
/* -------------------------------------------------------------------------- */

/**
 * One card in the agent's own gallery.
 *
 * Compare `ScreenshotCard` in `screenshotViewerRules.ts`, which carries an
 * `agent: { id, name }`. There is no agent on this one, and its absence is the
 * point: every row in this payload belongs to the person reading it, so a name
 * would be either their own — noise — or evidence that the scoping had failed.
 *
 * No `storageKey`, for the reason the admin card has none: the column is not
 * selected by the query that builds this, so there is no filesystem detail in
 * the response, in the browser's memory or in anything the browser might later
 * send somewhere.
 */
export interface MyScreenshotCard {
  id: string;
  capturedAt: string;
  width: number;
  height: number;
  fileSize: number;
  /** The shift it was taken during. Times only — no id is needed to draw it. */
  workSession: { startedAt: string; endedAt: string | null } | null;
  /**
   * The server's activity figure for the minute this capture falls in, when
   * one was recorded. Null is common and honest: activity is reported on its
   * own cadence and a capture can land in a minute that has no interval.
   *
   * It is a share of a configured events rate and it is not a productivity
   * score — see `lib/activityRules.ts`.
   */
  activityPercentage: number | null;
}

export interface MyScreenshotPayload {
  screenshots: MyScreenshotCard[];
  /** The cursor for the next page, or null at the end of the list. */
  nextCursor: string | null;
  /** Whether a further request would return anything. */
  hasMore: boolean;
}
