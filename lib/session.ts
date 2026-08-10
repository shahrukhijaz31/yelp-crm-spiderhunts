import { createHash, randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { cache } from "react";

import { SESSION_COOKIE, type Role, type SessionUser } from "./access";
import { prisma } from "./prisma";

/**
 * Server-side sessions, stored in Postgres.
 *
 * This module is server-only by construction rather than by the `server-only`
 * package: it imports `next/headers` and the Prisma client, both of which fail
 * the build if they are ever pulled into a client component. Adding a
 * dependency to restate that would not make it any more true.
 *
 * The cookie holds a 256-bit random token and nothing else — no user id, no
 * role, no expiry the browser could edit. Everything about who you are is
 * looked up server-side on every request, which is what makes "the database is
 * the source of truth for `role`" literally true rather than aspirational: a
 * role change or a disabled account takes effect on the user's very next
 * request, without waiting for a token to expire.
 *
 * Only the SHA-256 of the token is written to the table. A database backup, a
 * log line or a stray `SELECT *` therefore cannot be replayed as a login.
 * SHA-256 without a work factor is correct here and would be wrong for a
 * password: the input is 32 bytes of CSPRNG output, so there is no dictionary
 * to run against it and nothing for a slow hash to buy.
 *
 * Lifetime is two clocks:
 *   IDLE      12 hours, pushed forward while the session is being used. Long
 *             enough to cover a shift plus lunch without a surprise logout.
 *   ABSOLUTE  7 days from sign-in, never extended. A tab left open on a shared
 *             machine forever still has to re-authenticate eventually.
 */

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Only refresh the idle clock once an hour. Writing a row on every request
 * would turn every page view into a database write for no security gain.
 */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Cookie attributes.
 *
 * `secure` is on in production only, because development is plain http and a
 * Secure cookie would simply never be sent — the failure would look like "login
 * does nothing". Production is HTTPS at nginx, which is the only way in.
 *
 * `sameSite: "lax"` keeps the cookie off cross-site POSTs (the CSRF exposure
 * for the state-changing routes here) while still arriving when someone
 * follows a link to the portal from elsewhere.
 */
function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

/**
 * Start a session for a user who has just proved who they are.
 *
 * A brand-new token every time, so signing in never adopts an identifier the
 * client already had — that is what closes session fixation. The old cookie's
 * session, if any, is deleted rather than left orphaned.
 */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
): Promise<void> {
  const cookieStore = await cookies();

  const previous = cookieStore.get(SESSION_COOKIE)?.value;
  if (previous) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(previous) } });
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + IDLE_MS);
  const absoluteExpiresAt = new Date(now + ABSOLUTE_MS);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      absoluteExpiresAt,
      // Truncated: enough to tell two sessions apart in a list, not a log.
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
    },
  });

  // The cookie's own expiry matches the idle window; the row is what is
  // actually enforced. A browser that ignores the attribute gains nothing.
  cookieStore.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

/**
 * Resolve the current request's session to a user, or null.
 *
 * `cache` memoises this for the duration of one render pass, so a layout, a
 * page and a leaf component asking "who is this?" cost one query between them.
 *
 * Everything that could make a session invalid is checked here, in the order
 * that costs least: no cookie, no row, expired (either clock), user disabled.
 * An invalid session is deleted on sight so a dead row cannot linger.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      lastSeenAt: true,
      // Never select passwordHash. Nothing downstream needs it, and a value
      // that is never loaded cannot be leaked by a careless serialisation.
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          role: true,
          isActive: true,
        },
      },
    },
  });

  if (!session) return null;

  const now = new Date();
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (!session.user.isActive) {
    // Disabling an account ends its sessions immediately, not at next expiry.
    await prisma.session.deleteMany({ where: { userId: session.user.id } }).catch(() => {});
    return null;
  }

  // Rolling idle expiry, at most once an hour, capped by the absolute clock.
  if (now.getTime() - session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    const extended = new Date(
      Math.min(now.getTime() + IDLE_MS, session.absoluteExpiresAt.getTime()),
    );
    await prisma.session
      .update({
        where: { id: session.id },
        data: { expiresAt: extended, lastSeenAt: now },
      })
      .catch(() => {});
  }

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    username: session.user.username,
    role: session.user.role as Role,
  };
});

/**
 * End the current session: the row first, then the cookie.
 *
 * Row first is deliberate. If the response is lost in flight the cookie
 * survives on the client, but it now points at nothing — the session is over
 * either way. Clearing the cookie first and failing to delete the row would
 * leave a live session with a token still sitting in the browser's history of
 * requests.
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await prisma.session
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => {});
  }

  // `set` with an expiry in the past rather than `delete`, so the attributes
  // (path, secure, httpOnly) match the ones it was set with — a mismatch on
  // path is the classic reason a "deleted" cookie comes back.
  cookieStore.set(SESSION_COOKIE, "", cookieOptions(new Date(0)));
}

/** Sign a user out of every browser. Used when a role changes or an account is disabled. */
export async function destroyAllSessionsFor(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * Sign a user out everywhere *except* the browser making this request.
 *
 * For changing your own password, which must not log you out of the tab you
 * are typing in — but must end every other session, because "I think someone
 * else knows my password" is the most common reason anyone changes one, and a
 * change that leaves the intruder signed in achieves nothing.
 *
 * Falls back to ending every session if the current cookie cannot be read: the
 * safe direction to fail is fewer live sessions, not more.
 */
export async function destroyOtherSessionsFor(userId: string): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  await prisma.session.deleteMany({
    where: token ? { userId, tokenHash: { not: hashToken(token) } } : { userId },
  });
}

/**
 * Housekeeping: drop rows whose clocks have run out.
 *
 * Called opportunistically from the login route rather than on a timer — this
 * app runs as two short-lived blue/green processes, so a background interval
 * would be an unreliable place to put it.
 */
export async function pruneExpiredSessions(): Promise<void> {
  const now = new Date();
  await prisma.session
    .deleteMany({
      where: { OR: [{ expiresAt: { lte: now } }, { absoluteExpiresAt: { lte: now } }] },
    })
    .catch(() => {});
}
