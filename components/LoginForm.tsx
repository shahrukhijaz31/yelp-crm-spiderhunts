"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Eye, EyeOff, Loader2, LockKeyhole } from "lucide-react";

import PasswordRecoveryPanel from "./PasswordRecoveryPanel";
import ThemeToggle from "./ThemeToggle";
import { AUTH_ERROR_MESSAGES, signIn } from "@/lib/auth";

/**
 * The sign-in screen.
 *
 * **A split, not a card.** This was a 400px card centred on an empty page,
 * which is the default shape of every sign-in form ever built and says nothing
 * about the product behind it. It is now two halves: the left states what this
 * is and who it belongs to, the right does the one job. On a laptop that reads
 * as a product entrance; below `lg` the brand panel drops away entirely and the
 * form centres on its own, because a 40%-width brand panel on a phone is a
 * 40%-height obstacle between someone and the thing they came to do.
 *
 * The left panel is the one place in the app that spends a real atmosphere
 * budget: a deep chromatic wash, a hairline grid, and two counter-rotating
 * blooms drifting behind it over 34 seconds (see `.auth-brand`). The grid is
 * what keeps that from reading as a screensaver — light moving behind a fixed
 * structure reads as depth, the same light moving over nothing reads as a
 * screen saver.
 *
 * Everything on the page rises 10px into place on a 90ms stagger, top to
 * bottom, left column first: mark → statement → heading → form → footnote. One
 * movement each, none of them repeating.
 *
 * Validation runs on submit, then live on every keystroke — so nobody is
 * scolded for a field they have not finished typing, but a field they have
 * corrected clears itself immediately.
 */

/**
 * The entrance, as spreadable props.
 *
 * Returns a class and a custom property rather than Framer variants — see the
 * `.auth-enter` block in `globals.css` for why this page animates in CSS: a
 * Framer `initial` is server-rendered as an inline `opacity: 0`, and on a
 * sign-in screen "invisible until JavaScript arrives" is a lockout.
 *
 * A single definition rather than a `variants` tree, because the stagger here
 * crosses two sibling `<section>`s — the brand column and the form column —
 * and a parent orchestrator would have to wrap both, which would mean the
 * animation dictating the layout. Passing an explicit delay keeps the DOM the
 * shape the design wants and makes the running order readable at each call
 * site.
 */
function rise(seconds: number) {
  return {
    className: "auth-enter",
    style: { "--delay": `${Math.round(seconds * 1000)}ms` } as React.CSSProperties,
  };
}

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
  /**
   * Recovery replaces the form in place rather than living on its own route.
   * The brand column, the theme control and the entrance animation all stay
   * put, so "I forgot my password" is a change of question on one screen — and
   * there is no `/reset` URL for anyone to arrive at cold, out of context and
   * without a code.
   */
  const [recovering, setRecovering] = useState(false);

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
    <main className="flex min-h-full flex-1">
      {/* ================= brand ========================================= */}
      {/* Below `lg` this is not rendered at all rather than hidden: it holds
          no information the form needs, and a phone should download and lay
          out nothing for it. */}
      <section className="auth-brand relative hidden w-[44%] max-w-[600px] shrink-0 flex-col justify-between p-10 lg:flex xl:p-14">
        {/* z-10 on all three: the animated bloom is `::after` at z-0 and the
            structural grid is `::before` at z-1, so content has to clear both
            or the grid would print over the wordmark. */}
        <div className="auth-enter relative z-10 flex items-center gap-3">
          {/* The mark in its breathing halo — see `.auth-halo`. This is the one
              looping foreground animation in the app, and it exists because a
              logo on a sign-in screen is the single element that is allowed to
              be purely presentational. */}
          <span className="auth-halo flex h-12 w-12 items-center justify-center rounded-xl border border-line-2 bg-surface/70 backdrop-blur">
            <Image
              src="/logo.ico"
              alt=""
              aria-hidden="true"
              width={32}
              height={32}
              unoptimized
              priority
              // Desaturated on purpose, here and everywhere else the mark is
              // drawn. This app spends its one signal colour on things an agent
              // must act on — a red status, an overdue callback, the primary
              // button — and a logo that competes for that colour spends it on
              // something nobody needs to look at twice.
              className="h-8 w-8 rounded object-contain grayscale"
            />
          </span>
          {/* The product's name, at a size that says it is the name of the
              product. It was set at `text-ui` — the same 13px as a form label
              — which is the size a wordmark takes when it is decoration in a
              corner, and this one is the first thing on the page. */}
          <span className="text-[22px] font-semibold leading-tight tracking-[-0.025em] text-fg">
            SpiderHunts Leads Portal
          </span>
        </div>

        {/* The one statement on the page. Set large and tight, at the size a
            heading is allowed to be when it is the only thing in its half of
            the screen — and still nowhere near the scale of a marketing hero,
            because this is a door into a tool, not a landing page. */}
        <div
          className="auth-enter relative z-10 max-w-[24ch]"
          style={{ "--delay": "80ms" } as React.CSSProperties}
        >
          <h2 className="text-[34px] font-semibold leading-[1.15] tracking-[-0.03em] text-fg xl:text-[40px]">
            The call list, and everything that happens to it.
          </h2>
          <p className="mt-5 text-ui leading-relaxed text-fg-2">
            Statuses, callbacks, meetings and recordings. One workspace for the
            whole outbound desk.
          </p>
        </div>

        <p
          className="auth-enter relative z-10 text-caption text-fg-3"
          style={{ "--delay": "160ms" } as React.CSSProperties}
        >
          © {new Date().getFullYear()} SpiderHunts
        </p>
      </section>

      {/* ================= form ========================================== */}
      <section className="auth-form flex min-w-0 flex-1 flex-col items-center justify-center px-5 py-12 sm:px-8">
        {/* The shell is not rendered on this route, so the theme control comes
            with the page — an agent on a night shift should not have to sign in
            through a screen set to the wrong theme first. */}
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-[380px]">
          {/* The mark appears on this side only when the brand panel is gone,
              so it is never shown twice on one screen. It keeps the halo: on a
              phone this is the only branding there is. */}
          <div className="auth-enter mb-8 flex items-center gap-3 lg:hidden">
            <span className="auth-halo flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line-2 bg-surface/70">
              <Image
                src="/logo.ico"
                alt=""
                aria-hidden="true"
                width={32}
                height={32}
                unoptimized
                priority
                className="h-8 w-8 rounded object-contain grayscale"
              />
            </span>
            {/* A step down from the brand column's 22px: this one shares a
                380px column with the form rather than owning half the screen. */}
            <span className="text-[19px] font-semibold leading-tight tracking-[-0.025em] text-fg">
              SpiderHunts Leads Portal
            </span>
          </div>

          {recovering ? (
            <div {...rise(0.02)}>
              <PasswordRecoveryPanel
                onBack={() => {
                  setRecovering(false);
                  // Come back to a clean form. Whatever banner sent them to
                  // recovery is answered by now, one way or the other.
                  setFormError(null);
                  setPassword("");
                  setChecked(false);
                }}
              />
            </div>
          ) : (
            <>
          <header {...rise(0.06)}>
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-fg">
              Sign in
            </h1>
            <p className="mt-2 text-ui leading-relaxed text-fg-3">
              Use the workspace credentials issued to you.
            </p>
          </header>

          {/* One banner for failures that belong to the attempt rather than a
              field. role="alert" so it is announced, not just seen. */}
          {/* Slides down rather than appearing, so the form visibly makes
              room for it instead of the fields jumping. `AnimatePresence`
              gives it a matching exit when the agent starts retyping. */}
          <AnimatePresence initial={false}>
            {formError && (
              <motion.div
                key="form-error"
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: "auto", marginTop: 24 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
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
                  <span>{formError}</span>
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <form
            noValidate
            onSubmit={handleSubmit}
            className="auth-enter mt-7 flex flex-col gap-4"
            style={{ "--delay": "120ms" } as React.CSSProperties}
          >
            {/* --- username --- */}
            <div className="flex flex-col gap-1.5">
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
                // Taller than the 36px chassis the rest of the app uses. There
                // are two fields here and nothing to fit around them, so they
                // get the comfortable height a dense table cannot afford.
                className="ui-field h-11 w-full"
              />
              {showErrors.username && (
                <FieldError id={`${usernameId}-error`}>{showErrors.username}</FieldError>
              )}
            </div>

            {/* --- password --- */}
            <div className="flex flex-col gap-1.5">
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
                  className="ui-field h-11 w-full pr-11"
                />
                <button
                  type="button"
                  onClick={() => setRevealed((current) => !current)}
                  disabled={submitting}
                  aria-pressed={revealed}
                  aria-controls={passwordId}
                  title={revealed ? "Hide password" : "Show password"}
                  // 32px target inside a 44px field, and fg-3 rather than fg-4:
                  // this is a control people hunt for when a password will not
                  // take, not decoration beside the field.
                  // Scales to 0.9 on press — the smallest control on the page, so
                  // it needs the largest proportional response to feel clicked.
                  className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 transition-all duration-150 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg active:scale-90 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {revealed ? (
                    <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  )}
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
              className="ui-btn ui-btn-primary mt-2 h-11 w-full"
            >
              {submitting && (
                <Loader2
                  className="h-4 w-4 animate-spin"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              )}
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          {/* A quiet link rather than a second button: it is the exit for the
              minority who cannot get in, and it must not compete with the
              action ninety-nine people in a hundred came here for. */}
          <div
            className="auth-enter mt-5 text-center"
            style={{ "--delay": "170ms" } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => setRecovering(true)}
              className="rounded text-caption text-fg-3 underline decoration-line-2 underline-offset-4 transition-colors duration-150 hover:text-fg hover:decoration-fg-4"
            >
              Forgot your password?
            </button>
            <p className="mt-1.5 text-caption leading-relaxed text-fg-3">
              Contact your workspace administrator to reset your password.
            </p>
          </div>

          <p
            className="auth-enter mt-8 flex items-center justify-center gap-2 text-caption text-fg-3"
            style={{ "--delay": "200ms" } as React.CSSProperties}
          >
            <LockKeyhole className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            Access is issued by your workspace administrator.
          </p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-caption leading-snug text-danger">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
