"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, MailCheck } from "lucide-react";

import {
  cancelOtp,
  OTP_ERROR_MESSAGES,
  RESEND_ERROR_MESSAGES,
  resendOtp,
  verifyOtp,
  type OtpErrorCode,
} from "@/lib/auth";
import { OTP_LENGTH, type PendingChallenge } from "@/lib/otpRules";

/**
 * "Verify your identity" — the second step of signing in.
 *
 * It renders inside the sign-in page's right-hand column, at the same width and
 * with the same field chassis as the password form and the recovery panel, so
 * moving between them reads as one screen changing its mind rather than three
 * different pages. The brand column, the theme control and the entrance
 * animation all stay put.
 *
 * **This screen verifies nothing.** Every digit typed here is sent to
 * `POST /api/auth/otp/verify` and compared against a scrypt hash in Postgres;
 * there is no expected value in this file to compare against, no code in
 * `localStorage`, `sessionStorage`, the URL or any cookie JavaScript can read.
 * The countdowns are drawn from timestamps the server sent and are re-checked
 * by the server on every attempt — running them out early, or editing them, is
 * worth exactly nothing.
 *
 * The six boxes are the one piece of real interaction design here, and the
 * rules they follow are the ones people actually need:
 *
 *   type      a digit fills the box and moves on; the last digit submits
 *   paste     a six-digit code dropped anywhere fills all six and submits
 *   backspace clears this box, or steps back if it is already empty
 *   arrows    move between boxes; Home/End jump to either end
 *
 * Auto-submitting on the sixth digit is deliberate: there is nothing else this
 * screen could be for, and making someone reach for a button after typing the
 * last digit of a code they are holding in their head is a small cruelty. The
 * button stays, for anyone who arrives at it by keyboard or retries after an
 * error.
 */
export default function OtpVerificationPanel({
  challenge: initialChallenge,
  callbackUrl,
  onBack,
  onDone,
}: {
  challenge: PendingChallenge;
  callbackUrl?: string;
  /** Return to the password form. The caller decides what that looks like. */
  onBack: () => void;
  /** A real session now exists; the caller navigates into the portal. */
  onDone: (redirectTo: string) => void;
}) {
  const [challenge, setChallenge] = useState(initialChallenge);
  const [digits, setDigits] = useState<string[]>(() => Array(OTP_LENGTH).fill(""));
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** True once the code is spent — keeps the screen still while the router moves. */
  const [done, setDone] = useState(false);

  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  /**
   * The last code auto-submit acted on. Without it, the effect below would fire
   * again on every re-render while six digits are still on screen — including
   * the re-render that shows "that code is not correct".
   */
  const lastSubmitted = useRef<string | null>(null);

  const code = digits.join("");

  /* ----- clocks ---------------------------------------------------------- */

  // One second-ticking clock for both countdowns rather than two intervals, and
  // it stops as soon as neither has anything left to count.
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = new Date(challenge.expiresAt).getTime();
  const resendAt = new Date(challenge.resendAvailableAt).getTime();
  const expiresIn = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = expiresIn === 0;

  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [done]);

  useEffect(() => {
    boxes.current[0]?.focus();
  }, []);

  /* ----- submit ---------------------------------------------------------- */

  const submit = useCallback(
    async (value: string) => {
      if (submitting || done) return;

      lastSubmitted.current = value;
      setSubmitting(true);
      setError(null);
      setNotice(null);

      const result = await verifyOtp({ code: value, callbackUrl });

      if (result.ok) {
        // Left `submitting` and `done` on purpose: the boxes stay filled and
        // frozen while the router navigates, instead of flickering back to an
        // empty form behind the new page.
        setDone(true);
        onDone(result.redirectTo);
        return;
      }

      setSubmitting(false);

      const message = OTP_ERROR_MESSAGES[result.code as OtpErrorCode] ?? OTP_ERROR_MESSAGES.server;
      setError(
        result.code === "invalid_code" && typeof result.attemptsRemaining === "number"
          ? `${message} ${
              result.attemptsRemaining === 1
                ? "1 attempt remaining."
                : `${result.attemptsRemaining} attempts remaining.`
            }`
          : message,
      );

      // A pending sign-in that no longer exists cannot be rescued by retyping,
      // so hand the screen back to the password form rather than leaving
      // someone typing into a box that will refuse everything.
      if (result.code === "no_pending" || result.code === "account_disabled") {
        setDigits(Array(OTP_LENGTH).fill(""));
        return;
      }

      // Clear and re-arm. Keeping the wrong digits on screen invites the same
      // wrong code to be submitted again by a stray Enter.
      setDigits(Array(OTP_LENGTH).fill(""));
      lastSubmitted.current = null;
      boxes.current[0]?.focus();
    },
    [callbackUrl, done, onDone, submitting],
  );

  // Auto-submit on the sixth digit — from typing or from a paste, which is why
  // it lives here rather than in the change handler.
  useEffect(() => {
    if (code.length !== OTP_LENGTH) return;
    if (submitting || done || expired) return;
    if (lastSubmitted.current === code) return;
    void submit(code);
  }, [code, done, expired, submit, submitting]);

  /* ----- the six boxes --------------------------------------------------- */

  function place(startIndex: number, incoming: string) {
    const cleaned = incoming.replace(/\D/g, "");
    if (!cleaned) return;

    setError(null);
    setNotice(null);

    setDigits((current) => {
      const next = [...current];
      for (let offset = 0; offset < cleaned.length && startIndex + offset < OTP_LENGTH; offset++) {
        next[startIndex + offset] = cleaned[offset];
      }
      return next;
    });

    const landed = Math.min(startIndex + cleaned.length, OTP_LENGTH - 1);
    boxes.current[landed]?.focus();
    boxes.current[landed]?.select();
  }

  function handleKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace") {
      event.preventDefault();
      setError(null);
      lastSubmitted.current = null;

      setDigits((current) => {
        const next = [...current];
        if (next[index]) {
          next[index] = "";
        } else if (index > 0) {
          next[index - 1] = "";
        }
        return next;
      });

      if (!digits[index] && index > 0) boxes.current[index - 1]?.focus();
      return;
    }

    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      boxes.current[index - 1]?.focus();
      boxes.current[index - 1]?.select();
    }
    if (event.key === "ArrowRight" && index < OTP_LENGTH - 1) {
      event.preventDefault();
      boxes.current[index + 1]?.focus();
      boxes.current[index + 1]?.select();
    }
    if (event.key === "Home") {
      event.preventDefault();
      boxes.current[0]?.focus();
    }
    if (event.key === "End") {
      event.preventDefault();
      boxes.current[OTP_LENGTH - 1]?.focus();
    }
  }

  /* ----- resend ---------------------------------------------------------- */

  async function handleResend() {
    if (resending || submitting || resendIn > 0 || !challenge.canResend) return;

    setResending(true);
    setError(null);
    setNotice(null);

    const result = await resendOtp();
    setResending(false);

    if (!result.ok) {
      setError(RESEND_ERROR_MESSAGES[result.code]);
      return;
    }

    // A new code is live and the old one is dead — so the boxes must be empty,
    // not holding six digits that will now be refused.
    setChallenge(result.challenge);
    setDigits(Array(OTP_LENGTH).fill(""));
    lastSubmitted.current = null;
    setNow(Date.now());
    setNotice("A new code is on its way. Check your inbox.");
    boxes.current[0]?.focus();
  }

  async function handleBack() {
    // Best-effort: the code dies on its own in five minutes, so a failed cancel
    // must not trap anyone on this screen.
    await cancelOtp();
    onBack();
  }

  const busy = submitting || done;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={handleBack}
        disabled={busy}
        className="ui-btn ui-btn-ghost -ml-2 mb-5 h-8 w-fit px-2 text-caption"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Back to sign in
      </button>

      <header>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
          Verify your identity
        </h1>
        <p className="mt-2 text-ui leading-relaxed text-fg-3">
          We sent a {OTP_LENGTH}-digit verification code to:
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-ui font-medium text-fg">
          <MailCheck className="h-4 w-4 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden="true" />
          {/* Masked server-side. The full address is never sent to this screen. */}
          <span className="break-all">{challenge.maskedEmail}</span>
        </p>
      </header>

      {/* One live region for both the failure banner and the "code sent"
          confirmation, so a screen reader hears the outcome of an action rather
          than a field quietly changing underneath it. */}
      <div aria-live="polite">
        <AnimatePresence initial={false}>
          {(error || notice) && (
            <motion.div
              key={error ? "otp-error" : "otp-notice"}
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: "auto", marginTop: 24 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
              className="overflow-hidden"
            >
              {error ? (
                <p
                  role="alert"
                  className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-bg px-3 py-2.5 text-caption leading-relaxed text-danger"
                >
                  <AlertCircle
                    className="mt-px h-4 w-4 shrink-0"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span>{error}</span>
                </p>
              ) : (
                <p className="flex items-start gap-2.5 rounded-md border border-line-2 bg-surface px-3 py-2.5 text-caption leading-relaxed text-fg-2">
                  <CheckCircle2
                    className="mt-px h-4 w-4 shrink-0 text-fg-3"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span>{notice}</span>
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (code.length === OTP_LENGTH) void submit(code);
        }}
        className="mt-7 flex flex-col gap-4"
      >
        {/* `fieldset`/`legend` rather than a label: six inputs are one control,
            and a screen reader should hear what they are for once, not six
            times. The legend is visually hidden because the heading above
            already says it on screen. */}
        <fieldset disabled={busy} className="min-w-0 border-0 p-0">
          <legend className="sr-only">Enter your {OTP_LENGTH}-digit verification code</legend>

          <div className="flex items-center justify-between gap-2 sm:gap-2.5">
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(element) => {
                  boxes.current[index] = element;
                }}
                type="text"
                // `inputMode` gives phones the number pad without `type=number`,
                // which brings spinners, accepts `e` and `-`, and silently
                // discards leading zeros.
                inputMode="numeric"
                // Only on the first box: iOS and Android offer the code from the
                // notification here and fill the rest through the paste path.
                autoComplete={index === 0 ? "one-time-code" : "off"}
                // maxLength 1 keeps a box to one digit; a longer paste is caught
                // by `onPaste` and distributed across the row.
                maxLength={1}
                value={digit}
                onChange={(event) => place(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={(event) => {
                  event.preventDefault();
                  // Always from the first box: a code pasted into box four is
                  // still a whole code, and filling boxes 4-6 with its first
                  // three digits is never what anyone meant.
                  place(0, event.clipboardData.getData("text"));
                }}
                onFocus={(event) => event.currentTarget.select()}
                aria-label={`Digit ${index + 1} of ${OTP_LENGTH}`}
                // The error border comes from `.ui-field[aria-invalid="true"]`
                // in globals.css, so a wrong code marks all six boxes with the
                // same rule every other invalid field in the app uses.
                aria-invalid={error ? true : undefined}
                // Large and readable, as a code being read off a phone
                // deserves: a 52px-tall box with the digit at 20px, against the
                // 44px fields on the password form.
                className="ui-field h-[52px] min-w-0 flex-1 text-center text-[20px] font-semibold tabular-nums tracking-normal"
              />
            ))}
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={busy || code.length !== OTP_LENGTH || expired}
          aria-busy={submitting}
          className="ui-btn ui-btn-primary mt-1 h-11 w-full"
        >
          {submitting && (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
          )}
          {submitting ? "Verifying…" : "Verify code"}
        </button>
      </form>

      {/* The expiry clock, stated plainly. It counts what the server will
          enforce, so it is information rather than a control. */}
      <p className="mt-4 text-center text-caption text-fg-3">
        {expired ? (
          <span className="text-danger">
            This code has expired. Request a new one to continue.
          </span>
        ) : (
          <>Code expires in {formatDuration(expiresIn)}</>
        )}
      </p>

      <div className="mt-5 text-center">
        <p className="text-caption text-fg-3">Didn&apos;t receive it?</p>

        {challenge.canResend ? (
          <button
            type="button"
            onClick={handleResend}
            disabled={resending || busy || resendIn > 0}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded text-caption font-medium text-fg-2 underline decoration-line-2 underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-fg-4 disabled:cursor-not-allowed disabled:text-fg-3 disabled:no-underline"
          >
            {resending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
            )}
            {resending
              ? "Sending…"
              : resendIn > 0
                ? `Resend code in ${resendIn}s`
                : "Resend code"}
          </button>
        ) : (
          <p className="mt-1.5 text-caption leading-relaxed text-fg-3">
            No more codes can be sent for this sign-in. Go back and start again.
          </p>
        )}
      </div>
    </div>
  );
}

/** `4:59`, or `47s` once there is no minute left to show. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
