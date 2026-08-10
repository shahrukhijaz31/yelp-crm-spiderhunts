"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

import PasswordField, { PasswordRequirements } from "./PasswordField";
import { changePassword, passwordChecks } from "@/lib/passwordRecovery";

/**
 * Profile → Change password, as a page.
 *
 * This began as a modal and should not have been. A password change is three
 * fields, a live requirements list and a strength meter — about 460px of
 * content before the error banner appears — and a dialog that tall has nowhere
 * to go on a laptop but off the top of the window, which is exactly what it
 * did. A page has the whole column and cannot be clipped by anything.
 *
 * It also has an address, which a dialog opened from a dropdown never did: an
 * administrator can now tell somebody "go to /account/password" instead of
 * describing a menu.
 *
 * Available to every role. `/account` is deliberately not an admin prefix in
 * `lib/access.ts` — this is the one screen an agent has that is about their own
 * account rather than the leads — and the page behind it resolves the caller
 * from the session, so there is no id here to point at anybody else.
 *
 * Layout follows Users and Settings exactly: a page title, an intro that says
 * what the screen does, and one `panel` holding the work. It is held to a
 * narrower column than those two because it is a form to fill in top to bottom,
 * not a list to scan.
 */
export default function ChangePasswordPanel() {
  const router = useRouter();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const checks = passwordChecks(next, confirm);
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && checks.every((check) => check.met);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;

    setSubmitting(true);
    setError(null);

    const result = await changePassword({
      currentPassword: current,
      newPassword: next,
      confirmPassword: confirm,
    });

    if (!result.ok) {
      setError(result.message);
      setSubmitting(false);
      return;
    }

    // Drop every value the moment the server has taken it. There is no reason
    // for three passwords to stay in component state behind a success screen.
    setCurrent("");
    setNext("");
    setConfirm("");
    setSubmitting(false);
    setDone(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header>
        <h1 className="page-title">Change password</h1>
        <p className="mt-3 page-intro">
          Enter your current password, then choose a new one. You will stay
          signed in here; any other browsers signed in to your account are
          signed out.
        </p>
      </header>

      {done ? (
        /* The form is replaced rather than kept underneath a banner. A
           confirmation above three now-stale password boxes invites a second
           submission of the same values, and it would fail — the old password
           is no longer the old password. */
        <section className="panel flex flex-col items-start gap-4 px-6 py-7">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-success-line bg-success-bg text-success">
            <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div>
            <h2 role="status" className="text-cell font-semibold text-fg">
              Password changed
            </h2>
            <p className="mt-2 text-ui leading-relaxed text-fg-3">
              Your new password is active. Use it the next time you sign in.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="ui-btn ui-btn-primary"
            >
              Back to the workspace
            </button>
            <button
              type="button"
              onClick={() => setDone(false)}
              className="ui-btn ui-btn-ghost"
            >
              Change it again
            </button>
          </div>
        </section>
      ) : (
        <form onSubmit={submit} noValidate className="panel flex flex-col gap-5 px-6 py-6">
          <PasswordField
            label="Current password"
            value={current}
            onChange={(value) => {
              setCurrent(value);
              setError(null);
            }}
            autoComplete="current-password"
            autoFocus
            disabled={submitting}
            hint="Required, so that a signed-in machine left unattended cannot be used to take over the account."
          />

          <div aria-hidden="true" className="h-px bg-line" />

          <PasswordField
            label="New password"
            value={next}
            onChange={(value) => {
              setNext(value);
              setError(null);
            }}
            autoComplete="new-password"
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
            // Only once there is something to compare: telling someone the
            // passwords do not match after one character is technically true
            // and entirely useless.
            error={mismatch ? "The new passwords do not match." : undefined}
          />

          <PasswordRequirements password={next} checks={checks} />

          {/* Slides down so the panel visibly makes room rather than the
              buttons jumping — the same treatment the sign-in banner gets. */}
          <AnimatePresence initial={false}>
            {error && (
              <motion.div
                key="error"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
                className="overflow-hidden"
              >
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
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
            <button
              type="submit"
              // Disabled on "not ready" rather than on "invalid": every field
              // starts empty, so this is the honest state of an unfinished
              // form, and the requirements list above says what is missing.
              disabled={!ready || submitting}
              aria-busy={submitting}
              className="ui-btn ui-btn-primary"
            >
              {submitting && (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
              )}
              {submitting ? "Changing…" : "Change password"}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              disabled={submitting}
              className="ui-btn ui-btn-ghost"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* The one thing worth saying that the form does not: nobody, at any
          privilege level, can read what is typed above. It sits under the form
          rather than over it — reassurance, not an instruction. */}
      <p className="flex items-start gap-2.5 text-caption leading-relaxed text-fg-4">
        <ShieldCheck className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        Passwords are stored hashed and cannot be read by anyone, including
        administrators. If you ever forget yours, an administrator can issue a
        one-time reset code — never reveal it.
      </p>
    </div>
  );
}
