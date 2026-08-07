"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import ThemeToggle from "./ThemeToggle";
import { AUTH_ERROR_MESSAGES, signIn } from "@/lib/auth";

/**
 * The sign-in screen.
 *
 * Deliberately the same material as the rest of the portal — `bg-surface` on
 * `bg-base`, `border-line` hairlines, the Fraunces wordmark from the nav bar,
 * the 36px control height and accent-red primary button used on every other
 * view. A login page is the first thing anyone sees, so a second design
 * language here would read as a different product.
 *
 * Small on purpose: a 384px card, not a full-bleed hero. Two fields do not
 * need half a screen, and the workspace this fronts is a dense table tool.
 *
 * Validation runs on submit, then live on every keystroke — so nobody is
 * scolded for a field they have not finished typing, but a field they have
 * corrected clears itself immediately.
 */

interface FieldErrors {
  username?: string;
  password?: string;
}

/** Deliberately loose: `a@b.c` is the shape, anything stricter rejects real addresses. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(username: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  const name = username.trim();

  if (!name) {
    errors.username = "Enter your username.";
  } else if (name.includes("@")) {
    // Some deployments issue email addresses as usernames, so an @ means the
    // person meant an email and should be told when it is malformed.
    if (!EMAIL.test(name)) errors.username = "Enter a valid email address.";
  } else if (name.length < 3) {
    errors.username = "Usernames are at least 3 characters.";
  }

  if (!password) errors.password = "Enter your password.";

  return errors;
}

export default function LoginForm({ callbackUrl }: { callbackUrl?: string }) {
  const router = useRouter();
  const usernameId = useId();
  const passwordId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** Field errors only show once the form has been submitted at least once. */
  const [checked, setChecked] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const errors = validate(username, password);
  const showErrors = checked ? errors : {};

  // Put the caret back in the emptied password box after a rejected attempt,
  // so retrying is a straight retype. It has to be an effect rather than a
  // call in the submit handler: the field is still `disabled` at that point,
  // and focusing a disabled input does nothing.
  useEffect(() => {
    if (formError) passwordRef.current?.focus();
  }, [formError]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecked(true);
    setFormError(null);

    // The button is disabled while submitting, not while invalid: a button
    // that is dead before you have typed gives no reason why. The field
    // messages appear on this first click instead.
    if (errors.username || errors.password) return;

    setSubmitting(true);
    try {
      const result = await signIn({ username: username.trim(), password, callbackUrl });
      if (result.ok) {
        // `replace`, not `push`: the login page should not be a Back
        // destination once you are through it. `refresh` as well, because the
        // portal layout is server-rendered per user — without it the router
        // could paint a shell built before the session existed.
        router.replace(result.redirectTo);
        router.refresh();
        return;
      }
      setFormError(AUTH_ERROR_MESSAGES[result.code]);
      // Clear the password and re-arm validation from scratch. Without the
      // reset, emptying the field would immediately fire "Enter your password"
      // underneath the banner — two messages for one failure, and the field
      // one is a lie: they did enter a password, it was just wrong.
      setPassword("");
      setRevealed(false);
      setChecked(false);
    } catch {
      setFormError(AUTH_ERROR_MESSAGES.network);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center px-5 py-10 sm:px-6">
      {/* The nav bar is hidden on this route, so the theme control comes with
          the page — an agent on a night shift should not have to sign in
          through a screen set to the wrong theme first. */}
      <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>

      <div className="flex w-full max-w-[400px] flex-col gap-7">
        {/* --- brand ---------------------------------------------------- */}
        <div className="flex flex-col items-center gap-3.5 text-center">
          <Image
            src="/logo.ico"
            alt=""
            aria-hidden="true"
            width={44}
            height={44}
            unoptimized
            priority
            // Not desaturated, unlike the nav bar's: up there the mark competes
            // with the active-tab red, and here there is nothing to compete
            // with. This is the one screen that is allowed to be branding.
            className="h-11 w-11 rounded-xl object-contain"
          />
          <h1 className="display-num text-[21px] leading-none text-fg">
            SpiderHunts <span className="text-fg-2">Leads Portal</span>
          </h1>
        </div>

        {/* --- card ----------------------------------------------------- */}
        <div className="rounded-2xl border border-line bg-surface px-5 py-7 sm:px-7">
          <header>
            {/* The card's own heading steps below the wordmark rather than
                matching it — two headings at one size is two first things. */}
            <h2 className="text-cell font-semibold leading-none text-fg">Sign in</h2>
            <p className="mt-2.5 text-ui leading-relaxed text-fg-3">
              Use the workspace credentials issued to you.
            </p>
          </header>

          {/* One banner for failures that belong to the attempt rather than a
              field. role="alert" so it is announced, not just seen. */}
          {formError && (
            <p
              role="alert"
              className="mt-5 flex items-start gap-2 rounded-lg border border-accent-3 bg-accent-soft px-3 py-2.5 text-ui leading-relaxed text-accent-2"
            >
              <WarningIcon />
              <span>{formError}</span>
            </p>
          )}

          <form noValidate onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            {/* --- username --- */}
            <div className="flex flex-col gap-2">
              <label htmlFor={usernameId} className="field-label">
                Username
              </label>
              <input
                id={usernameId}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                disabled={submitting}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setFormError(null);
                }}
                aria-invalid={showErrors.username ? true : undefined}
                aria-describedby={showErrors.username ? `${usernameId}-error` : undefined}
                placeholder="you@spiderhunts.com"
                // The error border now rides on `aria-invalid` inside
                // `.ui-field`, so the ring and what a screen reader is told
                // can no longer disagree.
                className="ui-field h-10 w-full"
              />
              {showErrors.username && (
                <FieldError id={`${usernameId}-error`}>{showErrors.username}</FieldError>
              )}
            </div>

            {/* --- password --- */}
            <div className="flex flex-col gap-2">
              <label htmlFor={passwordId} className="field-label">
                Password
              </label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  id={passwordId}
                  name="password"
                  type={revealed ? "text" : "password"}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={submitting}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFormError(null);
                  }}
                  aria-invalid={showErrors.password ? true : undefined}
                  aria-describedby={showErrors.password ? `${passwordId}-error` : undefined}
                  placeholder="••••••••"
                  // Right padding clears the reveal button, so a long password
                  // scrolls under the label rather than behind the icon.
                  className="ui-field h-10 w-full pr-11"
                />
                <button
                  type="button"
                  onClick={() => setRevealed((current) => !current)}
                  disabled={submitting}
                  aria-pressed={revealed}
                  aria-controls={passwordId}
                  title={revealed ? "Hide password" : "Show password"}
                  // 32px target inside a 40px field, and fg-3 rather than
                  // fg-4: this is a control people hunt for when a password
                  // will not take, not decoration beside the field.
                  className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                  <span className="sr-only">
                    {revealed ? "Hide password" : "Show password"}
                  </span>
                </button>
              </div>
              {showErrors.password && (
                <FieldError id={`${passwordId}-error`}>{showErrors.password}</FieldError>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              // `aria-busy` says to a screen reader what the spinner and the
              // changed label say to the eye.
              aria-busy={submitting}
              className="ui-btn ui-btn-primary mt-2 h-10 w-full"
            >
              {submitting && <Spinner />}
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="text-center text-caption leading-relaxed text-fg-3">
          Access is issued by your workspace administrator.
        </p>
      </div>
    </main>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-caption leading-snug text-accent-2">
      <WarningIcon />
      <span>{children}</span>
    </p>
  );
}

/**
 * Shared by the field errors and the form banner, so a failure looks the same
 * wherever it lands. `shrink-0` and the nudge down put it on the first line of
 * a message that wraps, rather than centred against the whole paragraph.
 */
function WarningIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mt-px h-3.5 w-3.5 shrink-0"
    >
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.9v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="10.8" r="0.65" fill="currentColor" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 animate-spin">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" opacity="0.3" />
      <path
        d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[15px] w-[15px]">
      <path
        d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[15px] w-[15px]">
      <path
        d="M6.3 3.8A6.3 6.3 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-2.2 2.7M9.8 9.9a2 2 0 0 1-2.8-2.8M4.2 5.1A11.9 11.9 0 0 0 1.5 8S4 12.5 8 12.5c.7 0 1.3-.1 1.9-.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m2.5 2.5 11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
