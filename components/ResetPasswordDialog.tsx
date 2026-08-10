"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, Clock, Copy, Loader2, ShieldAlert } from "lucide-react";

import { generateResetCode } from "@/lib/passwordRecovery";

/**
 * Admin → Users → Reset password.
 *
 * Two screens in one dialog, and the split is the safety feature: the first is
 * a plain statement of what pressing the button destroys, the second is the
 * code, shown once.
 *
 * The word on the trigger and on the confirm button is **reset**, never "view".
 * That is not a copy preference — there is no endpoint in this application that
 * returns a password or a hash to anybody, so "view" would describe an
 * operation that does not exist. The dialog says so out loud, because an
 * administrator who believes they *could* look is an administrator who will be
 * asked to.
 *
 * "This code will only be shown once" is likewise a fact rather than a policy:
 * the server stores a salted scrypt hash of it (`lib/passwordReset.ts`) and
 * keeps no copy that could be shown again. Losing it means generating another,
 * which is exactly what the copy says.
 */
export default function ResetPasswordDialog({
  user,
  onClose,
  onIssued,
}: {
  user: { id: string; name: string; username: string };
  onClose: () => void;
  /** Lets the Users page refresh its list so the "Reset pending" flag appears. */
  onIssued: () => void;
}) {
  const titleId = useId();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(30);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The "Copied" acknowledgement is a state with a life of its own rather than
  // a permanent label — after two seconds the button is offering to copy again.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function generate() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const result = await generateResetCode(user.id);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setCode(result.code ?? null);
    if (typeof result.expiresInMinutes === "number") setMinutes(result.expiresInMinutes);
    onIssued();
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard access can be refused, and there is nothing to recover: the
      // code is on screen in a font chosen to be read aloud accurately.
      setError("Could not copy automatically. Select the code above instead.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-base/60 backdrop-blur-[3px]"
      />

      <div className="panel-float pop-in relative w-full max-w-[420px] p-5 [--pop-origin:center]">
        {code === null ? (
          <>
            <header className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-line bg-accent-soft text-accent">
                <ShieldAlert className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-cell font-medium tracking-[-0.015em] text-fg">
                  Reset password
                </h2>
                <p className="mt-1 text-caption leading-relaxed text-fg-3">
                  Reset the password for{" "}
                  <span className="font-medium text-fg-2">{user.name}</span>?
                </p>
              </div>
            </header>

            <ul className="mt-4 flex flex-col gap-2 text-caption leading-relaxed text-fg-3">
              {/* Stated as consequences, not warnings. Each one is something
                  the administrator will otherwise discover from a confused
                  message twenty minutes from now. */}
              <Consequence>
                Their current password stops working immediately, and any
                browsers they are signed in on are signed out.
              </Consequence>
              <Consequence>
                A one-time reset code is generated for you to pass on. It expires
                in 30 minutes and works once.
              </Consequence>
              <Consequence>
                They must create a new password with it before they can use the
                portal again.
              </Consequence>
            </ul>

            <p className="mt-3.5 flex items-start gap-2 rounded-md border border-line bg-recessed/40 px-3 py-2 text-caption leading-relaxed text-fg-4">
              Passwords cannot be viewed by anyone, including administrators.
              A reset replaces the password rather than revealing it.
            </p>

            <ErrorBanner message={error} />

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="ui-btn ui-btn-ghost h-9"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={submitting}
                aria-busy={submitting}
                className="ui-btn ui-btn-primary h-9"
              >
                {submitting && (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
                )}
                {submitting ? "Generating…" : "Generate reset code"}
              </button>
            </div>
          </>
        ) : (
          <>
            <header>
              <h2 id={titleId} className="text-cell font-medium tracking-[-0.015em] text-fg">
                Password reset code
              </h2>
              <p className="mt-1 text-caption leading-relaxed text-fg-3">
                For {user.name} ({user.username})
              </p>
            </header>

            {/* The code, at the largest type in the application. It is going to
                be read down a phone line, which is the only reason anything
                here is this big. */}
            <p
              className="mt-4 select-all rounded-lg border border-accent-line bg-accent-soft px-4 py-4 text-center font-mono text-[26px] font-semibold tracking-[0.12em] text-fg"
              aria-live="polite"
            >
              {code}
            </p>

            <p className="mt-3 flex items-center justify-center gap-1.5 text-caption text-fg-3">
              <Clock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              Expires in {minutes} minutes.
            </p>

            <p className="mt-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-center text-caption font-medium leading-relaxed text-danger">
              This code will only be shown once. Save it before closing.
            </p>

            <ErrorBanner message={error} />

            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={() => void copy()} className="ui-btn ui-btn-secondary h-9">
                {copied ? (
                  <Check className="h-4 w-4 text-success" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy code"}
              </button>
              <button type="button" onClick={onClose} className="ui-btn ui-btn-primary h-9">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Consequence({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-fg-4" />
      <span>{children}</span>
    </li>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          key="error"
          initial={{ opacity: 0, height: 0, marginTop: 0 }}
          animate={{ opacity: 1, height: "auto", marginTop: 14 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
          className="overflow-hidden"
        >
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-caption leading-relaxed text-danger"
          >
            <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{message}</span>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
