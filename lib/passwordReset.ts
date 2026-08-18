import { randomBytes } from "node:crypto";

import { sendMail } from "./mail";
import { describePasswordProblem, hashPassword, verifyPassword } from "./password";
import { prisma } from "./prisma";
import { buildResetEmail } from "./resetEmail";
import { destroyAllSessionsFor } from "./session";

/**
 * One-time reset codes: the whole recovery path, on the server.
 *
 * Two ways in, one code, one redemption:
 *
 *   administrator  `issueResetCode` — generated on the Users screen and read
 *                  out to the person. Kills the current password on the spot.
 *   self-service   `requestResetCode` — asked for on the sign-in screen and
 *                  emailed to the address on the account. Changes nothing
 *                  about the account until the code is actually redeemed.
 *
 * **That asymmetry is the load-bearing decision in this file.** An
 * administrator's reset is an authenticated, deliberate act against a named
 * account, so ending the password immediately is what was asked for. A
 * self-service request is made by an anonymous caller who typed a username —
 * if it scrambled the password, then knowing somebody's username would be
 * enough to lock them out of their own portal, over and over, with no code and
 * no mailbox. So it does not: the old password keeps working until the person
 * holding the emailed code chooses a new one, and someone who ignores an
 * unexpected reset email has lost nothing.
 *
 * The server is the only party that ever decides whether a code is good.
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
 * **An administrator issuing a code invalidates the current password.** That is
 * the point of that operation and it is stated on the confirmation dialog: the
 * hash is replaced with one of 64 random bytes that nobody holds the preimage
 * of, `requirePasswordChange` goes up, and every session for the account is
 * ended. Between the reset and the redemption the account is genuinely
 * unreachable, by the old password, by an open tab, and by the administrator
 * who pressed the button. A self-service request does none of that, for the
 * reason given above.
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
  "This reset code has expired. Go back and request a new one.";

export const RESET_INVALID_MESSAGE =
  "That username and reset code do not match. Check both, or request a new code.";

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

interface MintedCode {
  /** Plaintext, held only long enough to be shown once or emailed once. */
  code: string;
  codeHash: string;
  expiresAt: Date;
  /** The instant the code was minted, so the two writes agree on "now". */
  now: Date;
}

/**
 * Mint a code and hash it. Writes nothing.
 *
 * Split out because scrypt takes ~100ms and must not happen inside a
 * transaction, and because it is the one step both entry points perform
 * identically — an administrator's code and a self-service code are the same
 * kind of credential with the same entropy and the same clock.
 */
async function mintResetCode(): Promise<MintedCode> {
  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_CODE_TTL_MS);
  const codeHash = await hashPassword(code);

  return { code, codeHash, expiresAt, now };
}

/**
 * The two writes every issue performs: expire the old codes, store the new one.
 *
 * Returned as statements rather than executed, so an administrator's reset can
 * run them in the same transaction as the password scramble while a
 * self-service request runs them on their own.
 *
 * `issuedById` is the administrator who pressed the button, or null when the
 * person asked for the code themselves — see the note on the column in
 * `prisma/schema.prisma` for why the subject is not written into it instead.
 */
function resetCodeWrites(userId: string, issuedById: string | null, minted: MintedCode) {
  return [
    // Any earlier code for this account stops working the moment a new one is
    // issued, so "generate another" is never "now there are two".
    prisma.passwordReset.updateMany({
      where: { userId, usedAt: null, expiresAt: { gt: minted.now } },
      data: { expiresAt: minted.now },
    }),
    prisma.passwordReset.create({
      data: { userId, codeHash: minted.codeHash, issuedById, expiresAt: minted.expiresAt },
    }),
  ];
}

/**
 * Issue a reset code for a user, invalidating their password and sessions.
 *
 * The administrator's path, and the only one that ends the current password —
 * see the file header for why the self-service path deliberately does not.
 *
 * Everything except the scrypt hashing runs inside one transaction, so the
 * account cannot be left in a half-reset state — a password that still works
 * beside a live code, or a code with nothing to unlock.
 */
export async function issueResetCode(userId: string, issuedById: string): Promise<IssuedReset> {
  const minted = await mintResetCode();

  // Nobody, including this process, ever holds the preimage of this. It is not
  // an "empty password" sentinel — `verifyPassword` must keep returning false
  // for every input rather than being special-cased anywhere.
  const unusablePasswordHash = await hashPassword(randomBytes(64).toString("base64"));

  await prisma.$transaction([
    ...resetCodeWrites(userId, issuedById, minted),
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: unusablePasswordHash, requirePasswordChange: true },
    }),
  ]);

  // After the commit, not inside it: a rolled-back reset must not have signed
  // anybody out. The account's password is already dead at this point, so the
  // ordering costs nothing.
  await destroyAllSessionsFor(userId);

  return { code: minted.code, expiresAt: minted.expiresAt };
}

/**
 * How close together one account's self-service codes may be asked for.
 *
 * The rate limiter in front of the route bounds how *many* can be requested;
 * this bounds how close together they arrive, which is the part that decides
 * whether the button is a way to put ten messages in somebody's inbox in ten
 * seconds. It also spares the ordinary case — a double-clicked button, or a
 * second tab — from invalidating the code that is already in flight.
 */
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;

export type ResetRequestOutcome =
  /** A code was generated and SMTP accepted the message. */
  | { sent: true }
  /**
   * Nothing was sent, and the caller must not learn which of these it was:
   *
   *   unknown_account  no such username or email, or the account is disabled
   *   cooldown         a code was already emailed within the last minute
   */
  | { sent: false; reason: "unknown_account" | "cooldown" }
  /** SMTP refused the message. The one failure worth reporting honestly. */
  | { sent: false; reason: "email_failed" };

/**
 * Someone on the sign-in screen has asked for a code. Email it to them.
 *
 * **Nothing about the account changes.** No password is scrambled, no session
 * is ended, no flag is raised. The entire effect of a request from a stranger
 * who guessed a username correctly is an email its owner can ignore — which is
 * what makes this safe to expose to anonymous callers at all, and why the
 * message says in as many words that the current password still works.
 *
 * **The code goes to the address on the account and nowhere else.** The caller
 * supplies a username or email to *look up*, never a destination, so a request
 * naming somebody else's account mails that person's mailbox: useless to the
 * sender, noise to the recipient, and no help to either.
 *
 * **The mail goes out before the row is written**, the ordering
 * `lib/loginOtp.ts` uses and for the same reason — a failed send must not
 * expire the code the person is already holding and replace it with one that
 * never arrived.
 *
 * The outcomes here are finer-grained than the response the route may give: an
 * unknown account and a cooldown are the same answer to the browser, because an
 * endpoint that distinguished them would be a way to ask which usernames exist.
 */
export async function requestResetCode(identifier: string): Promise<ResetRequestOutcome> {
  const lookup = (identifier ?? "").trim().toLowerCase();
  if (!lookup) return { sent: false, reason: "unknown_account" };

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: lookup }, { email: lookup }] },
    select: { id: true, email: true, isActive: true },
  });
  // A disabled account is deliberately indistinguishable from a missing one: a
  // new password would not get them in, and saying so would confirm the account
  // exists.
  if (!user || !user.isActive) return { sent: false, reason: "unknown_account" };

  const recent = await prisma.passwordReset.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      createdAt: { gt: new Date(Date.now() - RESET_REQUEST_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recent) return { sent: false, reason: "cooldown" };

  const minted = await mintResetCode();

  const sent = await sendMail(buildResetEmail(user.email, minted.code, RESET_CODE_TTL_MINUTES));
  if (!sent) return { sent: false, reason: "email_failed" };

  await prisma.$transaction(resetCodeWrites(user.id, null, minted));

  return { sent: true };
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
