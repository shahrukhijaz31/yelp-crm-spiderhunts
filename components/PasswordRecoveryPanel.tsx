"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  MailCheck,
  ShieldQuestion,
} from "lucide-react";

import PasswordField, { PasswordRequirements } from "./PasswordField";
import {
  completePasswordReset,
  formatResetCodeInput,
  passwordChecks,
  requestResetCode,
  verifyResetCode,
} from "@/lib/passwordRecovery";

/**
 * "Forgot your password?" — the whole recovery path, on the sign-in screen.
 *
 * Anyone with an account can get themselves back in without asking anybody:
 * they type the username they sign in with, and a one-time code goes to the
 * address on that account. An administrator can still issue a code by hand from
 * the Users screen — for someone who has lost the mailbox too — and the two
 * kinds of code are redeemed by the identical two steps below.
 *
 * Four steps, one at a time, because the person arriving here is already having
 * a bad minute:
 *
 *   ask       who they are, so the code has somewhere to go
 *   code      username + code, checked by the server before anything is shown
 *   password  choose a new one
 *   done      back to the ordinary sign-in form
 *
 * **The ask step never says whether the account exists.** The endpoint answers
 * every request identically (`app/api/auth/reset/request`), so this screen has
 * nothing to branch on, and says the only thing that is true either way: if
 * that account exists, a code is on its way to it. The wording is not
 * defensive vagueness — it is the whole reason an anonymous person can press
 * this button at all.
 *
 * **Asking for a code changes nothing about the account.** The current password
 * keeps working until somebody holding the emailed code chooses a new one, so a
 * request made in error — or by somebody who typed the wrong username — costs
 * its owner one email. The panel says so, because a person who receives an
 * unexpected reset code needs to know that ignoring it is the entire required
 * response.
 *
 * Nothing here signs anybody in. The reset endpoints issue no session by design
 * (`app/api/auth/reset/complete`), so the last step hands back to the form this
 * panel replaced — which is also the clearest possible signal that the new
 * password works.
 *
 * It renders inside the sign-in page's right-hand column, at the same width
 * and with the same field chassis, so switching between the two reads as one
 * screen changing its mind rather than a different page.
 */

type Step = "ask" | "code" | "password" | "done";

export default function PasswordRecoveryPanel({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>("ask");

  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState<string | null>(null);
  /**
   * Whether the code screen was reached by asking for one, rather than by
   * "I already have a code". It only decides whether the confirmation line is
   * shown — the step itself is identical either way, because an emailed code
   * and one read out by an administrator are the same credential.
   */
  const [emailed, setEmailed] = useState(false);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checks = passwordChecks(password, confirm);
  const ready = checks.every((check) => check.met);
  const mismatch = confirm.length > 0 && password !== confirm;

  function goToStep(next: Step) {
    setError(null);
    setStep(next);
  }

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || !username.trim()) return;

    setSubmitting(true);
    setError(null);

    const result = await requestResetCode({ username: username.trim() });
    setSubmitting(false);

    // Only a rate limit, a broken mailer or an unreachable server fails here.
    // "No such account" does not, and must not.
    if (!result.ok) {
      setError(result.message);
      return;
    }

    setEmailed(true);
    setStep("code");
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    const result = await verifyResetCode({ username: username.trim(), code });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setName(result.name ?? null);
    setStep("password");
  }

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;

    setSubmitting(true);
    setError(null);

    const result = await completePasswordReset({
      username: username.trim(),
      code,
      newPassword: password,
      confirmPassword: confirm,
    });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.message);
      // An expired or already-spent code cannot be rescued by retyping the
      // password, so send them back to the step that can actually be fixed —
      // where they can also ask for a fresh code. A password the server
      // rejected as too short is fixed right here, so that stays put.
      if (result.code === "expired" || result.code === "invalid") setStep("code");
      return;
    }

    // The code is spent and the password is set. Neither value has any further
    // use in this browser.
    setCode("");
    setPassword("");
    setConfirm("");
    setStep("done");
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={step === "ask" || step === "done" ? onBack : () => goToStep("ask")}
        className="ui-btn ui-btn-ghost -ml-2 mb-5 h-8 w-fit px-2 text-caption"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Back to sign in
      </button>

      {/* One region announced as a whole, so a screen reader hears the new step
          rather than a scatter of individually-changed fields. */}
      <div aria-live="polite">
        {step === "ask" && (
          <form onSubmit={sendCode} noValidate className="flex flex-col gap-5">
            <header>
              <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-line-2 bg-surface text-fg-3">
                <ShieldQuestion className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
                Forgot your password?
              </h1>
              <p className="mt-2 text-ui leading-relaxed text-fg-3">
                Type the username you sign in with and we will email a one-time
                reset code to the address on your account.
              </p>
            </header>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="reset-request-username" className="field-label">
                Username or email
              </label>
              <input
                id="reset-request-username"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                }}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                // The person pressed a button to reach this form; the caret
                // belongs in its first field.
                autoFocus
                disabled={submitting}
                className="ui-field h-11 w-full"
              />
            </div>

            <ErrorBanner message={error} />

            <div className="flex flex-col gap-2">
              <button
                type="submit"
                disabled={submitting || !username.trim()}
                aria-busy={submitting}
                className="ui-btn ui-btn-primary h-11 w-full"
              >
                {submitting && (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
                )}
                {submitting ? "Sending…" : "Email me a reset code"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEmailed(false);
                  goToStep("code");
                }}
                className="ui-btn ui-btn-ghost h-9 w-full text-caption"
              >
                I already have a code
              </button>
            </div>

            <div className="panel-inset flex items-start gap-3 px-4 py-3.5">
              <ShieldQuestion
                className="mt-0.5 h-4 w-4 shrink-0 text-fg-4"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <p className="text-caption leading-relaxed text-fg-3">
                Your current password keeps working until you use the code, so
                asking for one changes nothing. No longer have access to your
                email? Your workspace administrator can issue a code directly.
              </p>
            </div>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={submitCode} noValidate className="flex flex-col gap-4">
            <header>
              {emailed && (
                <p className="panel-inset mb-4 flex items-start gap-3 px-4 py-3 text-caption leading-relaxed text-fg-3">
                  <MailCheck
                    className="mt-0.5 h-4 w-4 shrink-0 text-fg-4"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  {/* Not "we sent you a code" — the server does not tell this
                      screen whether the account exists, and neither does it. */}
                  <span>
                    If that account exists, a code is on its way to the email
                    address on it.
                  </span>
                </p>
              )}
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
                Enter reset code
              </h1>
              <p className="mt-2 text-ui leading-relaxed text-fg-3">
                {emailed
                  ? "Check your inbox, then type the code below."
                  : "Type your username and the one-time code you were given."}
              </p>
            </header>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="reset-username" className="field-label">
                Username
              </label>
              <input
                id="reset-username"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                }}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                // Filled in already when a code was just requested; the caret
                // belongs on the code instead.
                autoFocus={!emailed}
                disabled={submitting}
                className="ui-field h-11 w-full"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="reset-code" className="field-label">
                Reset code
              </label>
              <input
                id="reset-code"
                value={code}
                // Formatted as it is typed, so a code read down a phone in
                // lower case with no dashes still lands correctly. The server
                // normalises again on arrival.
                onChange={(event) => {
                  setCode(formatResetCodeInput(event.target.value));
                  setError(null);
                }}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={emailed}
                disabled={submitting}
                className="ui-field h-11 w-full font-mono tracking-[0.08em]"
              />
              <p className="flex items-center gap-1.5 text-caption text-fg-4">
                <Clock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                Codes expire 30 minutes after they are generated.
              </p>
            </div>

            <ErrorBanner message={error} />

            <button
              type="submit"
              // `SH-XXXX-XXXX` is 12 characters once the mask has run, which
              // is the only shape the field can hold — so this is "finished
              // typing", not a validity claim.
              disabled={submitting || !username.trim() || code.length < 12}
              aria-busy={submitting}
              className="ui-btn ui-btn-primary mt-1 h-11 w-full"
            >
              {submitting && (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
              )}
              {submitting ? "Checking…" : "Continue"}
            </button>

            <p className="text-center text-caption text-fg-4">
              Code not arrived?{" "}
              <button
                type="button"
                onClick={() => goToStep("ask")}
                disabled={submitting}
                className="font-medium text-fg-2 underline underline-offset-2 hover:text-fg disabled:opacity-60"
              >
                Send another
              </button>
            </p>
          </form>
        )}

        {step === "password" && (
          <form onSubmit={submitPassword} noValidate className="flex flex-col gap-4">
            <header>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
                Create a new password
              </h1>
              <p className="mt-2 text-ui leading-relaxed text-fg-3">
                {name ? (
                  <>
                    Signing in as{" "}
                    <span className="font-medium text-fg-2">{name}</span>. Choose
                    a password only you know — nobody else can see it, including
                    your administrator.
                  </>
                ) : (
                  <>Choose a password only you know.</>
                )}
              </p>
            </header>

            <PasswordField
              label="New password"
              value={password}
              onChange={(value) => {
                setPassword(value);
                setError(null);
              }}
              autoComplete="new-password"
              autoFocus
              disabled={submitting}
              // No placeholder anywhere on the sign-in screen: the labels say
              // what each field is, and a row of dots in an empty password box
              // reads as a value that is already there.
              placeholder=""
            />

            <PasswordField
              label="Confirm new password"
              value={confirm}
              onChange={(value) => {
                setConfirm(value);
                setError(null);
              }}
              autoComplete="new-password"
              disabled={submitting}
              error={mismatch ? "The new passwords do not match." : undefined}
              placeholder=""
            />

            <PasswordRequirements password={password} checks={checks} />

            <ErrorBanner message={error} />

            <button
              type="submit"
              disabled={!ready || submitting}
              aria-busy={submitting}
              className="ui-btn ui-btn-primary mt-1 h-11 w-full"
            >
              {submitting && (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
              )}
              {submitting ? "Saving…" : "Set password"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="flex flex-col gap-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-success-line bg-success-bg text-success">
              <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <header>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
                Password set
              </h1>
              <p className="mt-2 text-ui leading-relaxed text-fg-3">
                The reset code has been used and no longer works. Sign in with
                your username and your new password.
              </p>
            </header>
            <button
              type="button"
              onClick={onBack}
              className="ui-btn ui-btn-primary mt-1 h-11 w-full"
            >
              Go to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The same banner the sign-in form uses, so a failure looks the same either side. */
function ErrorBanner({ message }: { message: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          key="error"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
          className="overflow-hidden"
        >
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-bg px-3 py-2.5 text-caption leading-relaxed text-danger"
          >
            <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{message}</span>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
