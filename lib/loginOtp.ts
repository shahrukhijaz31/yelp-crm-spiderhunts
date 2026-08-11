import { createHash, randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { sendMail } from "./mail";
import { buildOtpEmail } from "./otpEmail";
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  type PendingChallenge,
} from "./otpRules";
import { hashPassword, verifyPassword } from "./password";
import { prisma } from "./prisma";

/**
 * The second factor: a six-digit code, emailed, verified here and nowhere else.
 *
 * This module sits between "the password was right" and `createSession`. It is
 * the whole of the OTP step, and it is the only thing standing between those
 * two facts — nothing in `lib/session.ts`, `lib/authz.ts` or the proxy changed
 * to accommodate it, because a pending sign-in is deliberately not expressible
 * in the tables those read.
 *
 *   password verified  ->  issueLoginOtp   (pending row + browser-session cookie)
 *   code verified      ->  verifyLoginOtp  (returns a user id, still no session)
 *   caller             ->  createSession   (unchanged, as it always was)
 *
 * `verifyLoginOtp` returning a user id rather than creating the session itself
 * is the point of the split: the route that mints sessions is still the only
 * place a session is minted, so there remains exactly one line in the codebase
 * that turns an anonymous request into an identified one.
 *
 * **What the browser holds is a challenge token, not an identity.** 32 random
 * bytes in an HttpOnly cookie whose SHA-256 is the `login_otps.challenge_hash`
 * column — the same construction as the session cookie. It names nobody: the
 * user id is recovered by looking the hash up server-side, so a client cannot
 * ask to finish somebody else's sign-in, and cannot tell whose sign-in it is
 * holding.
 *
 * **The cookie has no expiry attribute on purpose.** That makes it a browser
 * session cookie, discarded when the browser closes — so someone who walks away
 * mid-verification comes back to the login form. It is not the enforcement,
 * though: `expiresAt` on the row is, and it is checked on the server on every
 * single attempt. A browser that keeps the cookie forever gains five minutes.
 *
 * **Six digits is only ~20 bits, and that is fine because of the limits.**
 * Five wrong guesses kill the code, five minutes kill the code, and one
 * successful use kills the code. Without all three a six-digit secret would be
 * guessable; with them, an attacker who already holds the password gets five
 * tries in five minutes at a one-in-a-million number.
 *
 * **The code is never stored, returned, or logged.** It exists in exactly two
 * places: the email, and the salted scrypt hash in `code_hash`. No function
 * here returns it, no response body carries it, and no `console` call in this
 * file takes it as an argument.
 *
 * ---------------------------------------------------------------------------
 * Two callers, one implementation
 * ---------------------------------------------------------------------------
 * The desktop Monitor (a separate Electron application on an agent's
 * workstation) signs in through the same second factor, and it has no cookie
 * jar. So every function below comes in two forms:
 *
 *   ...ForChallenge(token, …)   the actual logic. The caller says which pending
 *                               sign-in it means by handing over the token.
 *   the cookie wrapper          reads the token out of `OTP_COOKIE` and calls
 *                               the above. Unchanged behaviour for the browser.
 *
 * That split is deliberately *all* there is to it. There is no second OTP
 * implementation, no second table, no second set of limits and no second place
 * a code is checked — the desktop client meets the identical five attempts,
 * five minutes and single use, enforced by the identical lines. Where the
 * browser keeps its challenge token in an HttpOnly cookie, the Monitor keeps it
 * in the main process for the ninety seconds the screen is open; it names
 * nobody and grants nothing either way.
 */

/**
 * The numbers live in `lib/otpRules.ts` because the verification screen needs
 * them too, and a countdown that disagreed with the server would be worse than
 * no countdown. This file is the only place any of them is *enforced*.
 *
 * `OTP_MAX_SENDS` is the ceiling the cooldown cannot express: the cooldown
 * bounds the *rate* of mail, this bounds the *total*, so nobody can hold a
 * mailbox under a slow drip for an afternoon by pressing the button every 30
 * seconds.
 */
const OTP_TTL_MS = OTP_TTL_MINUTES * 60 * 1000;

/**
 * How long past its expiry a challenge can still be *resumed*.
 *
 * Not a grace period on the code — an expired code is refused at the instant it
 * expires, by `verifyLoginOtp`, and nothing here changes that. This is about
 * the screen: "your code expired, here is the Resend button" is the answer the
 * user needs, and it should survive a page refresh rather than being an
 * accident of the tab having stayed open. Past this window the sign-in is
 * genuinely abandoned and starts again from the password.
 */
const OTP_RESUME_GRACE_MS = 2 * OTP_TTL_MS;

const CHALLENGE_BYTES = 32;

/**
 * The pending-verification cookie.
 *
 * Named and prefixed on exactly the same rule as the session cookie
 * (`lib/access.ts`): `__Host-` in production, where it forces Secure, `Path=/`
 * and no `Domain` so a sibling host on this box cannot plant one; plain in
 * development, where a `__Host-` cookie could not be set over http at all.
 */
export const OTP_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_otp" : "lp_otp";

function hashChallenge(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Uniform digits from the CSPRNG.
 *
 * `randomBytes(1) % 10` would be biased — 256 is not a multiple of 10, so 0–5
 * would come up fractionally more often than 6–9 — and a biased second factor
 * is a smaller keyspace than it looks. Bytes at or above the largest usable
 * multiple of ten are discarded instead, the same rejection sampling
 * `lib/passwordReset.ts` uses for its alphabet.
 */
function generateOtp(): string {
  const limit = 256 - (256 % 10);
  let code = "";

  while (code.length < OTP_LENGTH) {
    for (const byte of randomBytes(OTP_LENGTH * 2)) {
      if (byte >= limit) continue;
      code += String(byte % 10);
      if (code.length === OTP_LENGTH) break;
    }
  }

  return code;
}

/** What people actually type: spaces, dashes and pasted formatting all welcome. */
export function normaliseOtp(raw: string): string {
  return (raw ?? "").replace(/\D/g, "").slice(0, OTP_LENGTH);
}

/**
 * `umar@company.com` -> `u••••@company.com`.
 *
 * The screen has to prove it sent the code somewhere the person recognises
 * without printing a full address onto a machine that may not be theirs — and
 * without handing an attacker who has just phished a password the mailbox to
 * attack next. The first character and the domain are enough to recognise your
 * own address and not enough to learn someone else's.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";

  const local = email.slice(0, at);
  const domain = email.slice(at);
  // Fixed-width mask rather than one dot per character: the length of the local
  // part is itself a hint worth not giving away.
  return `${local[0]}${"•".repeat(6)}${domain}`;
}

function describe(
  email: string,
  row: { expiresAt: Date; createdAt: Date; attempts: number },
  sends: number,
): PendingChallenge {
  return {
    maskedEmail: maskEmail(email),
    expiresAt: row.expiresAt.toISOString(),
    resendAvailableAt: new Date(
      row.createdAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000,
    ).toISOString(),
    attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts),
    canResend: sends < OTP_MAX_SENDS,
  };
}

/** Cookie attributes. No `expires`/`maxAge` — see the note at the top of the file. */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

async function readChallengeToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(OTP_COOKIE)?.value ?? null;
}

/**
 * Drop the pending state: the cookie, and every live row behind it.
 *
 * Called on "Back to login", and again the moment a code is redeemed, so a
 * finished or abandoned challenge leaves nothing usable behind.
 */
export async function clearPendingChallenge(): Promise<void> {
  const token = await readChallengeToken();
  const store = await cookies();

  if (token) await clearPendingForChallenge(token);

  // `set` with an expiry in the past rather than `delete`, so the attributes
  // match the ones it was set with — the same reason `destroySession` does.
  store.set(OTP_COOKIE, "", { ...cookieOptions(), expires: new Date(0) });
}

/**
 * Expire every live row behind a challenge, given the token directly.
 *
 * The cookie-free half of {@link clearPendingChallenge}, for callers that hold
 * their own token. There is no cookie to clear on that path — the client
 * discards the token itself — so this is only the database half.
 */
export async function clearPendingForChallenge(token: string): Promise<void> {
  await prisma.loginOtp
    .updateMany({
      where: { challengeHash: hashChallenge(token), usedAt: null },
      data: { expiresAt: new Date() },
    })
    .catch(() => {});
}

export type IssueResult =
  | { ok: true; challenge: PendingChallenge }
  | { ok: false; code: "email_failed" };

/** As {@link IssueResult}, plus the challenge token the caller must keep. */
export type IssueForChallengeResult =
  | { ok: true; token: string; challenge: PendingChallenge }
  | { ok: false; code: "email_failed" };

/**
 * Issue a code and hand the challenge token back to the caller.
 *
 * The whole of {@link issueLoginOtp} except the cookie: the mail goes out
 * first (a failed send must change nothing), a brand-new token is minted every
 * time so a token the client already held can never be adopted by a fresh
 * sign-in, and anything still pending under `previousToken` is expired on the
 * spot.
 *
 * The returned token is a credential for *finishing* this sign-in and nothing
 * else — it names nobody, and the code is still required. Callers must treat it
 * the way the browser treats the cookie: never persisted, never logged.
 */
export async function issueLoginOtpForChallenge(
  user: { id: string; email: string },
  previousToken?: string | null,
): Promise<IssueForChallengeResult> {
  const code = generateOtp();

  const sent = await sendMail(buildOtpEmail(user.email, code, OTP_TTL_MINUTES));
  if (!sent) return { ok: false, code: "email_failed" };

  const token = randomBytes(CHALLENGE_BYTES).toString("base64url");
  const challengeHash = hashChallenge(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  // Outside any transaction: scrypt takes ~100ms and a write lock has no
  // business being held open for it.
  const codeHash = await hashPassword(code);

  if (previousToken) await clearPendingForChallenge(previousToken);

  const row = await prisma.loginOtp.create({
    data: { userId: user.id, challengeHash, codeHash, expiresAt },
    select: { expiresAt: true, createdAt: true, attempts: true },
  });

  return { ok: true, token, challenge: describe(user.email, row, 1) };
}

/**
 * Start the OTP step for a user who has just proved their password.
 *
 * A brand-new challenge token every time, so a pending token the client already
 * held can never be adopted by a fresh sign-in — the same anti-fixation rule
 * `createSession` follows for real sessions.
 *
 * **The mail goes out before the row is written**, and the order matters. If it
 * were the other way round, a failed send would leave the account holding a
 * pending code nobody has, and the user staring at a box they cannot fill. This
 * way a failed send changes nothing at all and the caller can say so honestly.
 */
export async function issueLoginOtp(user: {
  id: string;
  email: string;
}): Promise<IssueResult> {
  // Anything still pending under the *previous* cookie stops working now. A
  // second sign-in attempt from the same browser must not leave the first
  // attempt's code alive behind it.
  const previous = await readChallengeToken();

  const issued = await issueLoginOtpForChallenge(user, previous);
  if (!issued.ok) return issued;

  const store = await cookies();
  store.set(OTP_COOKIE, issued.token, cookieOptions());

  return { ok: true, challenge: issued.challenge };
}

interface PendingRow {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
  attempts: number;
  user: {
    id: string;
    email: string;
    isActive: boolean;
    requirePasswordChange: boolean;
  };
}

/**
 * The newest unredeemed row for the challenge in this request's cookie.
 *
 * Only the newest: a resend pulls the previous row's clock back, so older rows
 * are expired by construction and are not candidates. Looking one up by
 * challenge rather than by user id is what keeps the client out of the
 * decision — it supplies a token, not a claim about who it is.
 */
async function loadPending(): Promise<PendingRow | null> {
  const token = await readChallengeToken();
  if (!token) return null;
  return loadPendingForChallenge(token);
}

/** {@link loadPending}, for a caller that holds its own challenge token. */
async function loadPendingForChallenge(token: string): Promise<PendingRow | null> {
  const row = await prisma.loginOtp.findFirst({
    where: { challengeHash: hashChallenge(token), usedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      codeHash: true,
      expiresAt: true,
      createdAt: true,
      attempts: true,
      user: {
        select: { id: true, email: true, isActive: true, requirePasswordChange: true },
      },
    },
  });

  return row;
}

async function countSends(challengeToken: string): Promise<number> {
  return prisma.loginOtp.count({ where: { challengeHash: hashChallenge(challengeToken) } });
}

/**
 * Read the pending state for rendering, without touching it.
 *
 * This is what makes refreshing the verification page work: the screen is
 * rebuilt from the server's view of the challenge rather than from React state
 * that a reload destroys. It returns no secret and grants nothing — the code is
 * still required, and is still checked from scratch by `verifyLoginOtp`.
 *
 * A recently-expired challenge is still described, deliberately (see
 * `OTP_RESUME_GRACE_MS`). The screen it produces says the code has expired and
 * offers a new one, which is exactly what a user whose code timed out needs —
 * and it means refreshing the page at that moment does not silently throw away
 * their sign-in. The expired code itself remains dead throughout.
 */
export async function describePendingChallenge(): Promise<PendingChallenge | null> {
  const token = await readChallengeToken();
  if (!token) return null;

  const row = await loadPending();
  if (!row) return null;
  if (row.expiresAt.getTime() + OTP_RESUME_GRACE_MS <= Date.now()) return null;
  if (!row.user.isActive) return null;

  return describe(row.user.email, row, await countSends(token));
}

export type VerifyResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      code: "no_pending" | "invalid_code" | "expired" | "too_many_attempts" | "account_disabled";
      attemptsRemaining?: number;
    };

/**
 * Check a submitted code and, if it is right, hand back whose sign-in it was.
 *
 * Every one of the four ways this can fail is decided here, on the server, from
 * the row: there is no client-side comparison anywhere in the app, and the code
 * the user typed is never sent back to them.
 *
 * The redemption is an `updateMany` guarded on `usedAt: null`, which is what
 * makes "single use" true under concurrency rather than merely in sequence: two
 * simultaneous submissions of the same correct code both pass the read above,
 * and the second updates zero rows and is refused.
 */
export async function verifyLoginOtp(rawCode: string): Promise<VerifyResult> {
  const token = await readChallengeToken();
  if (!token) return { ok: false, code: "no_pending" };
  return verifyLoginOtpForChallenge(token, rawCode);
}

/**
 * {@link verifyLoginOtp} for a caller that holds its own challenge token.
 *
 * This is where the check actually happens for *both* clients — the cookie
 * version above is a two-line lookup in front of it. Every limit, every failure
 * mode and the single-use `updateMany` guard are here and nowhere else, so a
 * desktop client cannot meet a weaker rule than a browser does.
 */
export async function verifyLoginOtpForChallenge(
  token: string,
  rawCode: string,
): Promise<VerifyResult> {
  const row = await loadPendingForChallenge(token);
  if (!row) return { ok: false, code: "no_pending" };

  const now = new Date();
  if (row.expiresAt <= now) return { ok: false, code: "expired" };

  // Belt and braces: the row is expired the moment the cap is reached below, so
  // this is only reachable by a request that raced the one that hit it.
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, code: "too_many_attempts" };

  const code = normaliseOtp(rawCode);
  const matches = code.length === OTP_LENGTH && (await verifyPassword(code, row.codeHash));

  if (!matches) {
    // Incremented in the database rather than from the value read above, so
    // parallel guesses each cost an attempt instead of overwriting each other.
    const updated = await prisma.loginOtp.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    if (updated.attempts >= OTP_MAX_ATTEMPTS) {
      // Destroy the code rather than merely refusing this attempt: the cap is
      // meant to end the guessing, not pause it.
      await prisma.loginOtp
        .update({ where: { id: row.id }, data: { expiresAt: new Date() } })
        .catch(() => {});
      return { ok: false, code: "too_many_attempts", attemptsRemaining: 0 };
    }

    return {
      ok: false,
      code: "invalid_code",
      attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - updated.attempts),
    };
  }

  const claimed = await prisma.loginOtp.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count === 0) return { ok: false, code: "no_pending" };

  // Re-checked at the moment of truth, not merely at the password step: an
  // account disabled during the five minutes someone spent reading their email
  // must not complete a sign-in. `requirePasswordChange` rides along for the
  // same reason.
  if (!row.user.isActive || row.user.requirePasswordChange) {
    return { ok: false, code: "account_disabled" };
  }

  return { ok: true, userId: row.userId };
}

export type ResendResult =
  | { ok: true; challenge: PendingChallenge }
  | {
      ok: false;
      code: "no_pending" | "cooldown" | "too_many_sends" | "email_failed";
      retryAfterSeconds?: number;
    };

/**
 * Send a fresh code for the sign-in already in progress.
 *
 * The challenge token is *not* rotated — this is the same pending sign-in, and
 * keeping the token is what lets the cooldown be read straight off the newest
 * row. The code very much is: a new row is written and the previous one's clock
 * is pulled back to now inside the same transaction, so there is no instant at
 * which two codes work.
 *
 * As at issue, the mail goes out first. A resend whose send fails leaves the
 * user's current code alive rather than replacing a working code with one that
 * never arrived.
 */
export async function resendLoginOtp(): Promise<ResendResult> {
  const token = await readChallengeToken();
  if (!token) return { ok: false, code: "no_pending" };
  return resendLoginOtpForChallenge(token);
}

/** {@link resendLoginOtp} for a caller that holds its own challenge token. */
export async function resendLoginOtpForChallenge(token: string): Promise<ResendResult> {
  const row = await loadPendingForChallenge(token);
  if (!row) return { ok: false, code: "no_pending" };
  if (!row.user.isActive) return { ok: false, code: "no_pending" };
  // A code that expired *recently* can still be replaced — that is the whole
  // point of the button. One that expired long ago belongs to a sign-in nobody
  // came back to, and is not resumable at any price: start from the password.
  if (row.expiresAt.getTime() + OTP_RESUME_GRACE_MS <= Date.now()) {
    return { ok: false, code: "no_pending" };
  }

  const now = Date.now();
  const nextAllowed = row.createdAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000;
  if (now < nextAllowed) {
    return {
      ok: false,
      code: "cooldown",
      retryAfterSeconds: Math.ceil((nextAllowed - now) / 1000),
    };
  }

  const sends = await countSends(token);
  if (sends >= OTP_MAX_SENDS) return { ok: false, code: "too_many_sends" };

  const code = generateOtp();
  const sent = await sendMail(buildOtpEmail(row.user.email, code, OTP_TTL_MINUTES));
  if (!sent) return { ok: false, code: "email_failed" };

  const codeHash = await hashPassword(code);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + OTP_TTL_MS);

  const [, fresh] = await prisma.$transaction([
    prisma.loginOtp.updateMany({
      where: { challengeHash: hashChallenge(token), usedAt: null },
      data: { expiresAt: issuedAt },
    }),
    prisma.loginOtp.create({
      data: {
        userId: row.userId,
        challengeHash: hashChallenge(token),
        codeHash,
        expiresAt,
      },
      select: { expiresAt: true, createdAt: true, attempts: true },
    }),
  ]);

  return { ok: true, challenge: describe(row.user.email, fresh, sends + 1) };
}

/**
 * Housekeeping, on the same opportunistic beat as session and reset-code
 * pruning (see the tail of the login route).
 *
 * Kept for an hour past their clock so that "this code has expired" can still
 * be said accurately to someone who is a few minutes late, then dropped. There
 * is nothing in an old row worth keeping — the code was never in it.
 */
export async function pruneExpiredLoginOtps(): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.loginOtp.deleteMany({ where: { expiresAt: { lte: cutoff } } }).catch(() => {});
}
