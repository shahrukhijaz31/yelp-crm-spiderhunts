"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  ShieldQuestion,
  UserCog,
} from "lucide-react";

import PasswordField, { PasswordRequirements } from "./PasswordField";
import {
  completePasswordReset,
  formatResetCodeInput,
  passwordChecks,
  RESET_CODE_PLACEHOLDER,
  verifyResetCode,
} from "@/lib/passwordRecovery";

/**
 * "Forgot your password?" — the whole recovery path, on the sign-in screen.
 *
 * This workspace issues no verified email addresses, so there is no reset link
 * to send and none is pretended: the first thing this panel says is who to ask.
 * Recovery is an out-of-band handoff — an administrator generates a one-time
 * code and reads it to the person — and the second thing the panel offers is
 * the place to type that code in.
 *
 * Three steps, one at a time, because the person arriving here is already
 * having a bad minute:
 *
 *   ask       who to contact, and the way in if they already have a code
 *   code      username + code, checked by the server before anything is shown
 *   password  choose a new one, then back to the ordinary sign-in form
 *
 * Nothing here signs anybody in. The reset endpoints issue no session by
 * design (`app/api/auth/reset/complete`), so the last step hands back to the
 * form this panel replaced — which is also the clearest possible signal that
 * the new password works.
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

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checks = passwordChecks(password, confirm);
  const ready = checks.every((check) => check.met);
  const mismatch = confirm.length > 0 && password !== confirm;

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
      // with a new code from their administrator. A password the server
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
        onClick={step === "ask" || step === "done" ? onBack : () => setStep("ask")}
        className="ui-btn ui-btn-ghost -ml-2 mb-5 h-8 w-fit px-2 text-caption"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Back to sign in
      </button>

      {/* One region announced as a whole, so a screen reader hears the new step
          rather than a scatter of individually-changed fields. */}
      <div aria-live="polite">
        {step === "ask" && <AskStep onHaveCode={() => setStep("code")} />}

        {step === "code" && (
          <form onSubmit={submitCode} noValidate className="flex flex-col gap-4">
            <header>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
                Enter reset code
              </h1>
              <p className="mt-2 text-ui leading-relaxed text-fg-3">
                Type your username and the one-time code your administrator gave
                you.
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
                // The person pressed a button to reach this form; the caret
                // belongs in its first field.
                autoFocus
                disabled={submitting}
                placeholder="you@spiderhunts.com"
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
                disabled={submitting}
                placeholder={RESET_CODE_PLACEHOLDER}
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

/**
 * The first thing someone locked out sees.
 *
 * It leads with the answer — ask your administrator — because that is true for
 * everyone arriving here, and only then offers the code entry, which is true
 * for the smaller group who have already made that call.
 */
function AskStep({ onHaveCode }: { onHaveCode: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-line-2 bg-surface text-fg-3">
          <ShieldQuestion className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
          Forgot your password?
        </h1>
        <p className="mt-2 text-ui leading-relaxed text-fg-3">
          Contact your workspace administrator to reset your password.
        </p>
      </header>

      <div className="panel-inset flex items-start gap-3 px-4 py-3.5">
        <UserCog className="mt-0.5 h-4 w-4 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />
        <p className="text-caption leading-relaxed text-fg-3">
          They will generate a one-time reset code for you. Nobody — including
          your administrator — can see your existing password; a reset replaces
          it rather than revealing it.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button type="button" onClick={onHaveCode} className="ui-btn ui-btn-primary h-11 w-full">
          Enter reset code
        </button>
        <p className="text-center text-caption text-fg-4">
          Already have a code? It is valid for 30 minutes.
        </p>
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
