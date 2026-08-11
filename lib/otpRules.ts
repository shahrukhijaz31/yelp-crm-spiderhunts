/**
 * The OTP rules, in one file, so the screen and the server cannot disagree.
 *
 * No imports on purpose — the same discipline `lib/access.ts` keeps, and for
 * the same reason: this module is pulled into a client component, so it must
 * stay free of Prisma, `next/headers`, Nodemailer and anything else with a
 * runtime of its own.
 *
 * Nothing here is enforcement. The countdown a user sees is drawn from these
 * numbers, but every one of them is checked again server-side on every request
 * (`lib/loginOtp.ts`) against the row in `login_otps` — a browser that edits
 * these values, or skips the screen entirely, meets exactly the same limits.
 */

/** Digits in a code. */
export const OTP_LENGTH = 6;

/** How long a code lives, from the moment it is emailed. */
export const OTP_TTL_MINUTES = 5;

/** Wrong guesses before the code is destroyed and a new one must be requested. */
export const OTP_MAX_ATTEMPTS = 5;

/** Seconds between "Resend code" presses. */
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

/** Codes per pending sign-in, the first one included. */
export const OTP_MAX_SENDS = 5;

/**
 * What the verification screen is told about the sign-in in progress.
 *
 * Deliberately not a user: no id, no name, no role, and no full email address —
 * only a masked one, so the screen can prove the code went somewhere the person
 * recognises without printing an address onto a machine that may not be theirs.
 * And, of course, never the code.
 */
export interface PendingChallenge {
  /** `u••••••@company.com` — see `maskEmail` in `lib/loginOtp.ts`. */
  maskedEmail: string;
  /** ISO timestamps. The screen counts down from them; the server re-checks them. */
  expiresAt: string;
  resendAvailableAt: string;
  attemptsRemaining: number;
  /** False once `OTP_MAX_SENDS` codes have gone out for this sign-in. */
  canResend: boolean;
}
