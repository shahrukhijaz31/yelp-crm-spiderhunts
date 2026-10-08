import { createHash, randomBytes } from "node:crypto";

import type { Role, SessionUser } from "./access";
import {
  checkMonitorEligibility,
  issueDeviceTokens,
  type DeviceInfo,
  type DeviceTokens,
  type EligibilityFailure,
} from "./monitorAuth";
import { PAIRING_TTL_MINUTES, type PairingRequestInfo } from "./monitorPairingRules";
import { prisma } from "./prisma";

/**
 * Connecting a workstation from the portal the agent is already signed in to.
 *
 * The counterpart of `lib/loginOtp.ts`, and almost everything true there is
 * true here: a short-lived row, only hashes at rest, single use enforced by a
 * guarded `updateMany` rather than by a read followed by a write, and the row
 * kept after use so a replay reads "already used" instead of "no such thing".
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Signing in to the portal is what starts an agent's shift; the Monitor cannot
 * open or close one. So by the time the desktop client asked for a password and
 * a second emailed code, the portal already knew exactly who was at that desk.
 * The second credential was duplicated effort, not a second check.
 *
 * ---------------------------------------------------------------------------
 * A pairing names nobody until somebody claims it
 * ---------------------------------------------------------------------------
 * {@link startPairing} takes no username, no email and no password. `user_id`
 * stays null for the whole pending life of the row and is written from the
 * approving session's own id — so there is no field anywhere on this path that
 * says whose workstation this is, and a client cannot ask for one account and
 * be given another. It also means the start endpoint cannot be used to discover
 * which accounts exist, which is a thing `/auth/login` can only mitigate with
 * timing equalisation.
 *
 * ---------------------------------------------------------------------------
 * What stops a phishing link, now that there is no code to type
 * ---------------------------------------------------------------------------
 * The approval URL alone decides, so the obvious attack is a link — "finish
 * setting up your Monitor" — carrying the attacker's request id, clicked by an
 * agent who is already signed in. Three things, none of which the agent has to
 * do anything for:
 *
 *   the network      the approval must come from the address the pairing was
 *                    started from. The Monitor and the browser are the same
 *                    machine, so this is invisible in ordinary use, and a
 *                    remote attacker's pairing starts somewhere else entirely
 *   the id           32 random bytes, five minutes, single use. Not guessable
 *                    and not enumerable
 *   the telling      every successful connection emails the agent, with a link
 *                    to the screen where one click disconnects it
 *
 * The residual case is an attacker on the same network as the agent, and what
 * they gain is the ability to pollute that agent's monitoring data — not portal
 * access, not leads. The email and the workstations list are how that is
 * caught. If it ever needs to be prevented rather than detected, a code the
 * agent types goes in {@link approvePairing} and nothing else changes.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not checked here
 * ---------------------------------------------------------------------------
 * `requirePasswordChange`. Setting it destroys every session for the account
 * (`lib/passwordReset.ts`), and `verifyLoginOtpForChallenge` refuses to create
 * one while it is set — so a live portal session already proves the flag is
 * clear, and a check here would be a second copy of a rule that cannot be
 * false. Role and `isActive` are different: they can change while a session is
 * open, so they are read fresh at approval and again at redemption.
 */

/** 32 random bytes, the construction every other token in this app uses. */
const TOKEN_BYTES = 32;

/** Kept this long past expiry before the sweep takes it. See {@link prunePairings}. */
const PRUNE_GRACE_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/* Starting                                                                   */
/* -------------------------------------------------------------------------- */

/** What the workstation is given. The device code exists nowhere else. */
export interface StartedPairing {
  /** Goes in the approval URL the Monitor opens in the browser. */
  requestId: string;
  /** The workstation's half, kept in its memory and never written to disk. */
  deviceCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

export async function startPairing(
  device: DeviceInfo,
  startIp: string | null,
): Promise<StartedPairing> {
  const requestId = newToken();
  const deviceCode = newToken();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MINUTES * 60 * 1000);

  await prisma.monitorPairing.create({
    data: {
      publicId: requestId,
      deviceCodeHash: hashToken(deviceCode),
      startIp,
      expiresAt,
      deviceName: trim(device.deviceName, 120),
      platform: trim(device.platform, 60),
      appVersion: trim(device.appVersion, 40),
    },
    select: { id: true },
  });

  return {
    requestId,
    deviceCode,
    expiresAt: expiresAt.toISOString(),
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
  };
}

/* -------------------------------------------------------------------------- */
/* Describing, for the approval screen                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the approval page shows, or null when there is nothing to show.
 *
 * Read-only and grants nothing. Null covers unknown, expired and already
 * handled alike: a page that distinguished them would turn the request id into
 * a way of asking whether somebody else's pairing exists.
 */
export async function describePairing(requestId: string): Promise<PairingRequestInfo | null> {
  if (!requestId) return null;

  const row = await prisma.monitorPairing
    .findUnique({
      where: { publicId: requestId },
      select: {
        publicId: true,
        deviceName: true,
        platform: true,
        appVersion: true,
        createdAt: true,
        expiresAt: true,
        approvedAt: true,
        deniedAt: true,
        consumedAt: true,
      },
    })
    .catch(() => null);

  if (!row) return null;
  if (row.approvedAt || row.deniedAt || row.consumedAt) return null;
  if (row.expiresAt <= new Date()) return null;

  return {
    requestId: row.publicId,
    deviceName: row.deviceName,
    platform: row.platform,
    appVersion: row.appVersion,
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Approving and denying                                                      */
/* -------------------------------------------------------------------------- */

export type ApproveResult =
  | { ok: true; deviceName: string | null }
  | {
      ok: false;
      code:
        | "not_found"
        | "already_handled"
        | "different_network"
        | "unknown_user"
        | EligibilityFailure;
    };

/**
 * The agent says yes.
 *
 * `userId` is the approving session's own id and the only place the account
 * comes from. Role and `isActive` are re-read from Postgres rather than taken
 * from the session object, because a role can change while a browser sits open
 * — and because a function that decides who may connect a workstation should
 * not be believing a caller about it. An administrator is refused here, rather
 * than at redemption, so the person gets an honest sentence on the screen
 * instead of a Monitor that polls for five minutes and then fails.
 *
 * Unknown, expired and already-handled all collapse into two codes that say
 * nothing about whether the id ever existed.
 */
export async function approvePairing(
  requestId: string,
  userId: string,
  approveIp: string | null,
): Promise<ApproveResult> {
  if (!requestId) return { ok: false, code: "not_found" };

  const row = await prisma.monitorPairing
    .findUnique({
      where: { publicId: requestId },
      select: {
        id: true,
        startIp: true,
        expiresAt: true,
        approvedAt: true,
        deniedAt: true,
        consumedAt: true,
        deviceName: true,
      },
    })
    .catch(() => null);

  if (!row) return { ok: false, code: "not_found" };
  if (row.approvedAt || row.deniedAt || row.consumedAt) return { ok: false, code: "already_handled" };
  if (row.expiresAt <= new Date()) return { ok: false, code: "not_found" };

  if (!sameNetwork(row.startIp, approveIp)) {
    console.warn(
      `[pairing] refused an approval from a different address than the request came from (user ${userId})`,
    );
    return { ok: false, code: "different_network" };
  }

  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { role: true, isActive: true } })
    .catch(() => null);

  if (!user) return { ok: false, code: "unknown_user" };

  const failure = checkMonitorEligibility({ role: user.role as Role, isActive: user.isActive });
  if (failure) return { ok: false, code: failure };

  // The claim. Guarded on every one of the conditions read above, so two tabs
  // pressing Connect at the same moment cannot both win, and a pairing that
  // expired or was denied in between is not approved by a stale read.
  const claimed = await prisma.monitorPairing.updateMany({
    where: {
      id: row.id,
      approvedAt: null,
      deniedAt: null,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { approvedAt: new Date(), userId },
  });

  if (claimed.count === 0) return { ok: false, code: "already_handled" };

  return { ok: true, deviceName: row.deviceName };
}

/**
 * The agent says no — or, more usefully, says "this was not me".
 *
 * Always succeeds, like a sign-out: "there was nothing to deny" is not a
 * failure worth reporting, and reporting it would say whether the id existed.
 * `user_id` stays null, because the column means "the account this was approved
 * for" and a refusal approved nothing. Who refused goes in the log instead.
 */
export async function denyPairing(requestId: string): Promise<void> {
  if (!requestId) return;

  await prisma.monitorPairing
    .updateMany({
      where: { publicId: requestId, approvedAt: null, deniedAt: null, consumedAt: null },
      data: { deniedAt: new Date() },
    })
    .catch(() => {});
}

/* -------------------------------------------------------------------------- */
/* Redeeming                                                                  */
/* -------------------------------------------------------------------------- */

export type RedeemResult =
  | { state: "pending" }
  | {
      state: "approved";
      tokens: DeviceTokens;
      user: SessionUser;
      userId: string;
      /** Carried out so the route can name the machine in the agent's email. */
      deviceName: string | null;
      platform: string | null;
    }
  | {
      state: "failed";
      code:
        | "invalid_device_code"
        | "pairing_denied"
        | "pairing_expired"
        | "pairing_consumed"
        | "unknown_user"
        | EligibilityFailure;
    };

/**
 * The workstation collects its credential.
 *
 * The row is claimed *before* the tokens are minted, which is the order
 * `/auth/verify` already argues for: two polls racing each other produce
 * exactly one device row, and the loser is told the pairing was already used
 * rather than quietly ending up with a second credential nobody knows about.
 *
 * `issueDeviceTokens` re-reads the account, so an agent disabled between the
 * click and the poll gets no tokens even though the approval stands.
 */
export async function redeemPairing(deviceCode: string): Promise<RedeemResult> {
  if (!deviceCode) return { state: "failed", code: "invalid_device_code" };

  const row = await prisma.monitorPairing
    .findUnique({
      where: { deviceCodeHash: hashToken(deviceCode) },
      select: {
        id: true,
        userId: true,
        approvedAt: true,
        deniedAt: true,
        consumedAt: true,
        expiresAt: true,
        deviceName: true,
        platform: true,
        appVersion: true,
      },
    })
    .catch(() => null);

  if (!row) return { state: "failed", code: "invalid_device_code" };
  if (row.deniedAt) return { state: "failed", code: "pairing_denied" };
  if (row.consumedAt) return { state: "failed", code: "pairing_consumed" };

  // Expiry is checked after denial so a refused request keeps saying it was
  // refused, which is the more useful sentence, rather than turning into "that
  // expired" five minutes later.
  if (row.expiresAt <= new Date()) return { state: "failed", code: "pairing_expired" };
  if (!row.approvedAt || !row.userId) return { state: "pending" };

  const claimed = await prisma.monitorPairing.updateMany({
    where: { id: row.id, consumedAt: null, approvedAt: { not: null } },
    data: { consumedAt: new Date() },
  });

  if (claimed.count === 0) return { state: "failed", code: "pairing_consumed" };

  const issued = await issueDeviceTokens(row.userId, {
    deviceName: row.deviceName,
    platform: row.platform,
    appVersion: row.appVersion,
  });

  if (!issued.ok) return { state: "failed", code: issued.code };

  return {
    state: "approved",
    tokens: issued.tokens,
    user: issued.user,
    userId: row.userId,
    deviceName: row.deviceName,
    platform: row.platform,
  };
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Drop pairings an hour past their expiry.
 *
 * Opportunistic, on the same beat as `pruneExpiredLoginOtps` — this app has no
 * cron. The hour of grace is what lets a late poll be told "that expired"
 * instead of "no such thing", which is the difference between the Monitor
 * showing a sentence a person can act on and showing a mystery.
 */
export async function prunePairings(): Promise<void> {
  const cutoff = new Date(Date.now() - PRUNE_GRACE_MS);
  await prisma.monitorPairing.deleteMany({ where: { expiresAt: { lte: cutoff } } }).catch(() => {});
}

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                        */
/* -------------------------------------------------------------------------- */

const POLL_INTERVAL_SECONDS = 5;

function trim(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Did the approval come from the same place the request did?
 *
 * The one check that makes a phishing link useless, so its failure modes are
 * worth being explicit about:
 *
 *   both known      compared exactly. The Monitor and the browser are the same
 *                   machine, so in ordinary use these are the same address
 *   either unknown  allowed. `clientIp` answers `"unknown"` when no trusted
 *                   proxy hop is configured, which is every development
 *                   machine; refusing there would mean the flow could not be
 *                   run locally at all. In production the deployment sets the
 *                   hop count, so this branch is not reachable — and the
 *                   alternative, treating two unknowns as a match, would be a
 *                   check that silently passes everything
 *
 * An agent approving from a phone on mobile data is refused, and should be:
 * the request came from their desktop, and the whole point is that the person
 * saying yes is sitting at the machine that asked.
 */
function sameNetwork(startIp: string | null, approveIp: string | null): boolean {
  if (!startIp || startIp === "unknown") return true;
  if (!approveIp || approveIp === "unknown") return true;
  return startIp === approveIp;
}
