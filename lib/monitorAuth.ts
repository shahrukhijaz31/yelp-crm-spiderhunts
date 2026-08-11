import { createHash, randomBytes } from "node:crypto";

import type { Role, SessionUser } from "./access";
import { prisma } from "./prisma";

/**
 * Authentication for the SpiderHunts Monitor desktop application.
 *
 * This is the token half of what `lib/session.ts` is for the browser, and it is
 * written to the same rules: the client holds 32 random bytes, only the SHA-256
 * reaches the database, the role is read from `users` on every request, and a
 * revocation is a row change that takes effect immediately. No JWT, so no
 * signing secret exists to distribute, rotate or leak — the same promise
 * `.env.example` already makes about sessions.
 *
 * ---------------------------------------------------------------------------
 * What this module deliberately cannot do
 * ---------------------------------------------------------------------------
 * **It cannot start, extend or end a work session.** Nothing here imports
 * `lib/workSessions.ts` or `lib/completeSignIn.ts`, so connecting a workstation
 * — or leaving one connected overnight — has no effect whatsoever on an agent's
 * shift clock. The portal remains the only thing that decides whether somebody
 * is working. The Monitor reads that state (`GET /api/monitor/session`) and
 * never writes it.
 *
 * **It cannot skip the second factor.** There is no path into
 * {@link issueDeviceTokens} except from the OTP verification route, which
 * reaches it only after `verifyLoginOtpForChallenge` has returned a user id.
 * A correct password alone produces a challenge token and nothing else.
 *
 * **It cannot authenticate an administrator.** {@link assertMonitorEligible} is
 * applied at sign-in *and* on every authenticated request, because a role can
 * change between the two.
 *
 * ---------------------------------------------------------------------------
 * The two clocks
 * ---------------------------------------------------------------------------
 *   ACCESS   15 minutes. Carried on every request. Short so that a token
 *            captured in flight or scraped from memory dies on its own.
 *   REFRESH  30 days, rotating on every use and never extended past its
 *            original ceiling. This is the one that survives an application
 *            restart, and the only thing the desktop client stores at rest.
 *
 * Rotation is what makes theft of the stored refresh token bounded rather than
 * permanent: the copy stops working the moment the real device refreshes, and
 * the legitimate device is then signed out — a visible failure rather than a
 * silent shared session.
 */

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

/**
 * Only touch `last_seen_at` once a minute. The desktop client polls, and
 * turning every poll into a row write would buy nothing.
 */
const TOUCH_AFTER_MS = 60 * 1000;

/** The only role the Monitor admits. See the module note. */
const MONITOR_ROLES: readonly Role[] = ["AGENT"];

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** What the client is given, and the only place a plaintext token exists. */
export interface DeviceTokens {
  accessToken: string;
  /** ISO instant. The client refreshes before this, not after. */
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

/** Client-supplied labels. Never authorization input — see the schema note. */
export interface DeviceInfo {
  deviceName?: string | null;
  platform?: string | null;
  appVersion?: string | null;
}

function trim(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Is this account allowed to connect a workstation at all?
 *
 * Returns a reason code rather than a boolean so the caller can answer
 * accurately: "your account is disabled" and "the Monitor is for agents" are
 * different facts and lead to different things the person should do next.
 *
 * Checked at sign-in and again on every authenticated request. A role change or
 * a disabled account therefore ends a device's access on its very next call,
 * without waiting for a token to expire — the same property `getSessionUser`
 * gives the browser.
 */
export type EligibilityFailure = "account_disabled" | "role_not_permitted";

export function checkMonitorEligibility(user: {
  role: Role;
  isActive: boolean;
}): EligibilityFailure | null {
  if (!user.isActive) return "account_disabled";
  if (!MONITOR_ROLES.includes(user.role)) return "role_not_permitted";
  return null;
}

/**
 * Mint a device's first token pair, at the end of a completed OTP sign-in.
 *
 * One row per connection rather than one per user: an agent with a laptop and a
 * desktop has two, and revoking one leaves the other working. Eligibility is
 * re-read from the database here rather than trusted from the caller, so this
 * function is safe to reach from anywhere — there is no argument that can talk
 * it into issuing tokens for an administrator or a disabled account.
 */
export type IssueResult =
  | { ok: true; tokens: DeviceTokens; user: SessionUser }
  | { ok: false; code: EligibilityFailure | "unknown_user" };

export async function issueDeviceTokens(
  userId: string,
  device: DeviceInfo = {},
): Promise<IssueResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, username: true, role: true, isActive: true },
  });

  if (!user) return { ok: false, code: "unknown_user" };

  const failure = checkMonitorEligibility({ role: user.role as Role, isActive: user.isActive });
  if (failure) return { ok: false, code: failure };

  const accessToken = newToken();
  const refreshToken = newToken();
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TTL_MS);
  const refreshExpiresAt = new Date(now + REFRESH_TTL_MS);

  await prisma.monitorDevice.create({
    data: {
      userId: user.id,
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt,
      refreshTokenHash: hashToken(refreshToken),
      refreshExpiresAt,
      deviceName: trim(device.deviceName, 120),
      platform: trim(device.platform, 60),
      appVersion: trim(device.appVersion, 40),
    },
  });

  return {
    ok: true,
    tokens: {
      accessToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshToken,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    },
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role as Role,
    },
  };
}

/**
 * Resolve `Authorization: Bearer <access token>` to a user.
 *
 * The Monitor's counterpart to `getSessionUser`, and it checks the same things
 * in the same order: no header, no row, expired, revoked, then the account
 * itself. Returns null for every one of them — a caller cannot tell an expired
 * token from a revoked one, and does not need to.
 */
/** The authenticated workstation: who it belongs to, and which device it is. */
export interface DeviceContext {
  user: SessionUser;
  /** `monitor_devices.id`, so an upload can record which laptop it came from. */
  deviceId: string;
}

export async function getDeviceUser(request: Request): Promise<SessionUser | null> {
  return (await getDeviceContext(request))?.user ?? null;
}

/**
 * As {@link getDeviceUser}, but also naming the device.
 *
 * Same lookup and the same checks — this is the full result and `getDeviceUser`
 * is the common case that only wants the person. Split this way so there is
 * still exactly one place where a bearer token becomes an identity.
 */
export async function getDeviceContext(request: Request): Promise<DeviceContext | null> {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  if (!token) return null;

  const device = await prisma.monitorDevice
    .findUnique({
      where: { accessTokenHash: hashToken(token) },
      select: {
        id: true,
        accessExpiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
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
    })
    .catch(() => null);

  if (!device) return null;

  const now = new Date();
  if (device.revokedAt) return null;
  if (!device.accessExpiresAt || device.accessExpiresAt <= now) return null;

  // Role and isActive from the database, on every request. A demoted or
  // disabled agent's device stops working here rather than at token expiry.
  const failure = checkMonitorEligibility({
    role: device.user.role as Role,
    isActive: device.user.isActive,
  });
  if (failure) {
    // Disabling an account ends its devices immediately, exactly as it ends
    // its browser sessions.
    await revokeAllDevicesFor(device.user.id).catch(() => {});
    return null;
  }

  if (now.getTime() - device.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    await prisma.monitorDevice
      .update({ where: { id: device.id }, data: { lastSeenAt: now } })
      .catch(() => {});
  }

  return {
    deviceId: device.id,
    user: {
      id: device.user.id,
      name: device.user.name,
      email: device.user.email,
      username: device.user.username,
      role: device.user.role as Role,
    },
  };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Both tokens are replaced in one update guarded on the old refresh hash, so
 * two clients racing a refresh cannot both win: the second matches no row and
 * is refused. `refresh_expires_at` is carried forward untouched — a refresh
 * buys a new access token, never a longer connection.
 */
export type RefreshResult =
  | { ok: true; tokens: DeviceTokens; user: SessionUser }
  | { ok: false; code: "invalid_refresh" | EligibilityFailure };

export async function refreshDeviceTokens(refreshToken: string): Promise<RefreshResult> {
  if (!refreshToken) return { ok: false, code: "invalid_refresh" };

  const device = await prisma.monitorDevice
    .findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      select: {
        id: true,
        refreshExpiresAt: true,
        revokedAt: true,
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
    })
    .catch(() => null);

  if (!device) return { ok: false, code: "invalid_refresh" };

  const now = new Date();
  if (device.revokedAt || device.refreshExpiresAt <= now) {
    return { ok: false, code: "invalid_refresh" };
  }

  const failure = checkMonitorEligibility({
    role: device.user.role as Role,
    isActive: device.user.isActive,
  });
  if (failure) {
    await revokeAllDevicesFor(device.user.id).catch(() => {});
    return { ok: false, code: failure };
  }

  const accessToken = newToken();
  const nextRefreshToken = newToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS);

  // Guarded on the presented hash: this is the rotation, and it must be
  // atomic. A second request holding the same (now spent) refresh token
  // updates zero rows and is told to sign in again.
  const rotated = await prisma.monitorDevice.updateMany({
    where: { id: device.id, refreshTokenHash: hashToken(refreshToken), revokedAt: null },
    data: {
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt,
      refreshTokenHash: hashToken(nextRefreshToken),
      lastSeenAt: now,
    },
  });

  if (rotated.count === 0) return { ok: false, code: "invalid_refresh" };

  return {
    ok: true,
    tokens: {
      accessToken,
      accessExpiresAt: accessExpiresAt.toISOString(),
      refreshToken: nextRefreshToken,
      refreshExpiresAt: device.refreshExpiresAt.toISOString(),
    },
    user: {
      id: device.user.id,
      name: device.user.name,
      email: device.user.email,
      username: device.user.username,
      role: device.user.role as Role,
    },
  };
}

/**
 * Sign one workstation out.
 *
 * Deliberately does **not** touch the agent's browser sessions or their work
 * session. Disconnecting the Monitor is not signing out of the portal, and an
 * agent who closes the desktop app is still at their desk with the worklist
 * open — stopping their clock here would silently lose them the rest of the
 * shift. The two authentication contexts stay separate, in both directions.
 *
 * Accepts either token, because the client may hold only one by the time it
 * gets here. Always succeeds: signing out is idempotent, and "there was nothing
 * to revoke" is not a failure worth reporting.
 */
export async function revokeDevice(token: {
  accessToken?: string | null;
  refreshToken?: string | null;
}): Promise<void> {
  const conditions: { accessTokenHash?: string; refreshTokenHash?: string }[] = [];
  if (token.accessToken) conditions.push({ accessTokenHash: hashToken(token.accessToken) });
  if (token.refreshToken) conditions.push({ refreshTokenHash: hashToken(token.refreshToken) });
  if (conditions.length === 0) return;

  await prisma.monitorDevice
    .updateMany({
      where: { OR: conditions, revokedAt: null },
      // The hashes are cleared as well as the row being marked: a revoked
      // device must not keep occupying the unique index, or the same random
      // token could never be issued again and a stale row would shadow a new
      // connection from the same workstation.
      data: {
        revokedAt: new Date(),
        accessTokenHash: null,
        accessExpiresAt: null,
        refreshTokenHash: `revoked:${randomBytes(16).toString("hex")}`,
      },
    })
    .catch(() => {});
}

/** Disconnect every workstation for a user. Used when an account is disabled. */
export async function revokeAllDevicesFor(userId: string): Promise<void> {
  const devices = await prisma.monitorDevice
    .findMany({ where: { userId, revokedAt: null }, select: { id: true } })
    .catch(() => []);

  for (const device of devices) {
    await prisma.monitorDevice
      .update({
        where: { id: device.id },
        data: {
          revokedAt: new Date(),
          accessTokenHash: null,
          accessExpiresAt: null,
          refreshTokenHash: `revoked:${randomBytes(16).toString("hex")}`,
        },
      })
      .catch(() => {});
  }
}

/**
 * Housekeeping, on the same opportunistic beat as `pruneExpiredSessions` — this
 * app has no cron. Only rows whose refresh ceiling has passed are dropped; a
 * revoked row is kept for a while as the trace that a device was disconnected.
 */
export async function pruneExpiredDevices(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.monitorDevice
    .deleteMany({ where: { refreshExpiresAt: { lte: cutoff } } })
    .catch(() => {});
}

/**
 * Guard for a Monitor route handler. Mirrors `apiUser()` in `lib/authz.ts`:
 * returns either the user or the Response to send back, so every handler opens
 * with the same three lines and cannot continue past a failure.
 */
export async function monitorUser(request: Request): Promise<SessionUser | Response> {
  const user = await getDeviceUser(request);
  return user ?? unauthorizedDevice();
}

/** As {@link monitorUser}, for a handler that also needs the device's identity. */
export async function monitorDevice(request: Request): Promise<DeviceContext | Response> {
  const context = await getDeviceContext(request);
  return context ?? unauthorizedDevice();
}

function unauthorizedDevice(): Response {
  return Response.json(
    { error: "unauthorized", message: "Sign in to connect this workstation." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
