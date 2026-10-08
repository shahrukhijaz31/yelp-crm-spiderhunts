/**
 * The workstation-pairing rules, in one file, so the approval screen and the
 * server cannot disagree.
 *
 * No imports on purpose — the same discipline `lib/otpRules.ts` and
 * `lib/access.ts` keep, and for the same reason: this module is pulled into a
 * client component, so it must stay free of Prisma, `next/headers` and
 * anything else with a runtime of its own.
 *
 * Nothing here is enforcement. The countdown on the approval card is drawn
 * from these numbers, and every one of them is checked again server-side on
 * every request (`lib/monitorPairing.ts`) against the row in
 * `monitor_pairings`.
 */

/**
 * How long a pending request lives, from the moment the Monitor asks.
 *
 * Shorter than the OTP's window, because the two are waiting for different
 * things. A code has to survive someone going to find their phone and reading
 * an email that may be slow to arrive; this is waiting for a person to look at
 * the browser already open in front of them. Five minutes is generous for
 * that, and the shorter the window the smaller the chance a stale request is
 * sitting around to be stumbled into.
 */
export const PAIRING_TTL_MINUTES = 5;

/** How often the Monitor asks whether it has been approved yet. */
export const PAIRING_POLL_INTERVAL_SECONDS = 5;

/**
 * What the approval screen is told about the workstation asking to connect.
 *
 * Deliberately thin. No user id — a pending pairing belongs to nobody, which is
 * the property that lets the Monitor start one without naming an account. No
 * hash of anything, and never the device code: the page's job is to let a
 * person recognise their own machine and say yes, and every field here exists
 * for that.
 *
 * `deviceName` and the two beside it are what the workstation called itself,
 * recorded when it asked rather than read back from it later — see the schema
 * note on `monitor_pairings`.
 */
export interface PairingRequestInfo {
  /** The `public_id`, so the panel can post it back. Not the device code. */
  requestId: string;
  /** The workstation's own name for itself, usually its Windows hostname. */
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  /** ISO instants, so the card can say "asked 4 seconds ago" and count down. */
  requestedAt: string;
  expiresAt: string;
}
