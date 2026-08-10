import { randomBytes } from "node:crypto";

import { describePasswordProblem, hashPassword, verifyPassword } from "./password";
import { prisma } from "./prisma";
import { destroyAllSessionsFor } from "./session";

/**
 * One-time reset codes: the whole recovery path, on the server.
 *
 * This workspace has no outbound email — the addresses in `users` are sign-in
 * identifiers, not verified mailboxes — so the usual "we sent you a link" is
 * not available and is not faked. Recovery is instead an out-of-band handoff:
 * an administrator generates a code, reads it to the person, and the person
 * redeems it for a password of their own choosing. The server is the only
 * party that ever decides whether a code is good.
 *
 * Four properties, each enforced here rather than by the caller:
 *
 *   random      6 characters from a 32-symbol alphabet after the `SH-` prefix
 *               — 30 bits, drawn from `randomBytes` by rejection sampling so
 *               every symbol is equally likely. 30 bits would be thin for a
 *               password; it is ample for a credential that lives 30 minutes,
 *               works once, and is rate-limited per account.
 *   single-use  redemption stamps `usedAt`. The row is kept, so a replay finds
 *               "already used" rather than nothing — and issuing a new code
 *               expires every earlier one for that account in the same write.
 *   expiring    `expiresAt` is checked on the server on every attempt. A
 *               client that hides the form after 30 minutes has decided
 *               nothing.
 *   specific    a code is looked up *within* one user's rows, never globally,
 *               so a code issued for one person cannot unlock another even in
 *               the vanishing case of a collision.
 *
 * **The code is never stored.** `codeHash` holds the same salted scrypt output
 * `lib/password.ts` writes for passwords. Verification is affordable at that
 * cost because lookup is by user id — there is at most one live code per
 * account, so redeeming is one hash, not a table scan.
 *
 * **Issuing a code invalidates the current password.** That is the point of a
 * reset and it is stated on the confirmation dialog: the hash is replaced with
 * one of 64 random bytes that nobody holds the preimage of, `requirePasswordChange`
 * goes up, and every session for the account is ended. Between the reset and
 * the redemption the account is genuinely unreachable, by the old password, by
 * an open tab, and by the administrator who pressed the button.
 */

/** Ambiguous glyphs are out: no 0/O, no 1/I/L. Codes get read down a phone. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PREFIX = "SH";
/** Two groups of four, `SH-7K4P-92XM`, matching what the admin dialog promises. */
const GROUPS = 2;
const GROUP_LENGTH = 4;

export const RESET_CODE_TTL_MINUTES = 30;
const RESET_CODE_TTL_MS = RESET_CODE_TTL_MINUTES * 60 * 1000;

/**
 * Uniform random symbols.
 *
 * `randomBytes` then `% 31` would be biased — 256 is not a multiple of 31, so
 * the first nine letters of the alphabet would come up fractionally more often.
 * Bytes at or above the largest usable multiple are discarded instead.
 */
function randomSymbols(count: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";

  while (out.length < count) {
    for (const byte of randomBytes(count * 2)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === count) break;
    }
  }

  return out;
}

/** `SH-7K4P-92XM`. */
function generateCode(): string {
  const groups: string[] = [];
  for (let index = 0; index < GROUPS; index += 1) {
    groups.push(randomSymbols(GROUP_LENGTH));
  }
  return [PREFIX, ...groups].join("-");
}

/**
 * Accept what people actually type: lower case, missing dashes, a pasted value
 * with a space in it. Normalising here rather than at each call site means the
 * verify step and the complete step can never disagree about what a code is.
 */
export function normaliseResetCode(raw: string): string {
  const bare = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = bare.startsWith(PREFIX) ? bare.slice(PREFIX.length) : bare;
  if (body.length !== GROUPS * GROUP_LENGTH) return "";

  const groups: string[] = [];
  for (let index = 0; index < GROUPS; index += 1) {
    groups.push(body.slice(index * GROUP_LENGTH, (index + 1) * GROUP_LENGTH));
  }
  return [PREFIX, ...groups].join("-");
}

/** The one place that says how long a code lives, in words a person reads. */
export const RESET_EXPIRED_MESSAGE =
  "This reset code has expired. Please contact your workspace administrator for a new code.";

export const RESET_INVALID_MESSAGE =
  "That username and reset code do not match. Check both, or ask your administrator for a new code.";

export class ResetError extends Error {
  constructor(
    message: string,
    /** The form's vocabulary — see `lib/passwordRecovery.ts` on the client. */
    readonly code: "invalid" | "expired" | "weak_password",
  ) {
    super(message);
  }
}

export interface IssuedReset {
  /** Plaintext, returned exactly once and never persisted in this form. */
  code: string;
  expiresAt: Date;
}

/**
 * Issue a reset code for a user, invalidating their password and sessions.
 *
 * Everything except the scrypt hashing runs inside one transaction, so the
 * account cannot be left in a half-reset state — a password that still works
 * beside a live code, or a code with nothing to unlock.
 */
export async function issueResetCode(userId: string, issuedById: string): Promise<IssuedReset> {
  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_CODE_TTL_MS);

  // Hashing is deliberately outside the transaction: scrypt takes ~100ms, and
  // holding a write transaction open for it would be a lock nobody needs.
  const codeHash = await hashPassword(code);
  // Nobody, including this process, ever holds the preimage of this. It is not
  // an "empty password" sentinel — `verifyPassword` must keep returning false
  // for every input rather than being special-cased anywhere.
  const unusablePasswordHash = await hashPassword(randomBytes(64).toString("base64"));

  await prisma.$transaction([
    // Any earlier code for this account stops working the moment a new one is
    // issued, so "generate another" is never "now there are two".
    prisma.passwordReset.updateMany({
      where: { userId, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    }),
    prisma.passwordReset.create({
      data: { userId, codeHash, issuedById, expiresAt },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: unusablePasswordHash, requirePasswordChange: true },
    }),
  ]);

  // After the commit, not inside it: a rolled-back reset must not have signed
  // anybody out. The account's password is already dead at this point, so the
  // ordering costs nothing.
  await destroyAllSessionsFor(userId);

  return { code, expiresAt };
}

interface ResetSubject {
  id: string;
  name: string;
  username: string;
  isActive: boolean;
}

/**
 * Find the live reset row matching a username and code, or throw.
 *
 * Refusals are deliberately indistinguishable: no such user, wrong code and a
 * code belonging to somebody else all produce the same sentence, because the
 * alternative is an endpoint that tells an anonymous caller which usernames
 * exist and which of them are mid-reset. Expiry is the one exception — that
 * message is actionable ("ask for a new one") and is only reachable by someone
 * who already held a genuine code for that account.
 */
async function resolveReset(
  username: string,
  rawCode: string,
): Promise<{ reset: { id: string }; user: ResetSubject }> {
  const identifier = username.trim().toLowerCase();
  const code = normaliseResetCode(rawCode ?? "");
  if (!identifier || !code) throw new ResetError(RESET_INVALID_MESSAGE, "invalid");

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier }] },
    select: { id: true, name: true, username: true, isActive: true },
  });
  if (!user) throw new ResetError(RESET_INVALID_MESSAGE, "invalid");

  // Scoped to this user, newest first. Used rows are excluded here rather than
  // reported: a redeemed code is simply not a code any more.
  const candidates = await prisma.passwordReset.findMany({
    where: { userId: user.id, usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, codeHash: true, expiresAt: true },
    // More than one unused row can only exist as history from a superseded
    // issue (those get `expiresAt` pulled back rather than deleted), so this
    // is a small, bounded list — the cap is a guard, not an expectation.
    take: 5,
  });

  for (const candidate of candidates) {
    if (!(await verifyPassword(code, candidate.codeHash))) continue;

    // The code is real. Only now is it worth telling the caller about expiry.
    if (candidate.expiresAt <= new Date()) {
      throw new ResetError(RESET_EXPIRED_MESSAGE, "expired");
    }

    if (!user.isActive) {
      throw new ResetError(
        "This account has been disabled. Contact your administrator.",
        "invalid",
      );
    }

    return { reset: { id: candidate.id }, user };
  }

  throw new ResetError(RESET_INVALID_MESSAGE, "invalid");
}

/**
 * Step one of the recovery form: is this code good?
 *
 * Returns only the person's display name, so the next screen can say whose
 * password is being set. No session, no token and no privilege of any kind is
 * granted here — the code is checked again, from scratch, when the new
 * password is submitted, so a caller who skips this step is neither helped nor
 * hindered by having called it.
 */
export async function checkResetCode(
  username: string,
  code: string,
): Promise<{ name: string; username: string }> {
  const { user } = await resolveReset(username, code);
  return { name: user.name, username: user.username };
}

/**
 * Step two: redeem the code for a new password.
 *
 * The write is one transaction guarded on `usedAt: null`, which is what makes
 * "works only once" true under concurrency rather than merely in sequence: two
 * simultaneous redemptions of the same code both pass the read above, and the
 * second one updates zero rows and is refused.
 */
export async function completeReset(
  username: string,
  code: string,
  newPassword: string,
): Promise<{ name: string; username: string }> {
  const problem = describePasswordProblem(newPassword ?? "");
  if (problem) throw new ResetError(problem, "weak_password");

  const { reset, user } = await resolveReset(username, code);
  const passwordHash = await hashPassword(newPassword);

  const claimed = await prisma.passwordReset.updateMany({
    where: { id: reset.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) throw new ResetError(RESET_INVALID_MESSAGE, "invalid");

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, requirePasswordChange: false },
  });

  // Belt and braces: nothing can hold a session for this account (issuing the
  // code ended them all), but a reset finishing with a clean slate is the
  // property worth stating in code rather than inferring.
  await destroyAllSessionsFor(user.id);

  return { name: user.name, username: user.username };
}

/**
 * Housekeeping, called from the same opportunistic spot as session pruning.
 *
 * Rows are kept for a day past their clock so that "this code has expired" can
 * still be said accurately to someone who was handed one an hour ago, then
 * dropped — there is nothing in an old row worth keeping beyond that.
 */
export async function pruneExpiredResetCodes(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.passwordReset
    .deleteMany({ where: { expiresAt: { lte: cutoff } } })
    .catch(() => {});
}
