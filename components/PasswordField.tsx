"use client";

import { useId, useState } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";

import { passwordStrength, type PasswordCheck } from "@/lib/passwordRecovery";

/**
 * One password input, worn by every password form in the app.
 *
 * It exists because there are now four of them — change password (three
 * fields), the recovery flow (two), and they must not drift: the reveal toggle
 * in one place and not another is the kind of inconsistency people read as a
 * bug in the security of the thing.
 *
 * The reveal button is the same 32px control the sign-in form already uses,
 * lifted verbatim rather than re-invented, down to the `active:scale-90` — the
 * smallest control on the screen needs the largest proportional press response
 * to feel clicked.
 *
 * The value is never persisted, never defaulted, and never echoed anywhere but
 * this input. Revealing is local state that resets with the component.
 */
export default function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  disabled,
  error,
  hint,
  placeholder = "••••••••",
  required,
  compact,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string;
  hint?: string;
  placeholder?: string;
  /**
   * Native validation, for the forms that submit rather than validate as they
   * type. The password dialogs check their own rules and have no use for it;
   * "New user" wants the browser to refuse an empty submit before the request
   * is made.
   */
  required?: boolean;
  /**
   * Sit at `.ui-field`'s own 2.25rem instead of the roomier 2.5rem.
   *
   * The password dialogs are a column of password inputs and nothing else, so
   * the taller field is right there. In a form of ordinary `.ui-field` rows —
   * name, username, email, role — a 4px-taller password box is the one control
   * that does not line up, which is exactly the sort of thing this component
   * exists to stop.
   */
  compact?: boolean;
}) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="field-label">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          // Only ever set by a caller on the first field of a dialog it has
          // just opened, which is where the caret already belongs.
          autoFocus={autoFocus}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          placeholder={placeholder}
          // Right padding clears the reveal button, so a long password scrolls
          // under the label rather than behind the icon.
          className={`ui-field w-full pr-11 ${compact ? "" : "h-10"}`}
        />

        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          disabled={disabled}
          aria-pressed={revealed}
          aria-controls={id}
          title={revealed ? "Hide password" : "Show password"}
          className={`absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-fg-3 transition-all duration-150 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg active:scale-90 disabled:cursor-not-allowed disabled:opacity-55 ${
            compact ? "h-7 w-7" : "h-8 w-8"
          }`}
        >
          {revealed ? (
            <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className="sr-only">{revealed ? "Hide password" : "Show password"}</span>
        </button>
      </div>

      {error ? (
        <p
          id={`${id}-error`}
          className="flex items-start gap-1.5 text-caption leading-snug text-danger"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-caption leading-snug text-fg-4">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The requirements list, ticked live.
 *
 * Shown rather than hidden behind a failed submit: a rule you learn by
 * breaking it is a rule you resent. Each row is `aria-hidden` on the icon and
 * carries its state in the text colour *and* a word, so it does not rely on
 * green-versus-grey alone.
 */
export function PasswordRequirements({
  password,
  checks,
}: {
  password: string;
  checks: PasswordCheck[];
}) {
  const strength = passwordStrength(password);
  const filled = strength === "strong" ? 3 : strength === "fair" ? 2 : password ? 1 : 0;

  return (
    <div className="flex flex-col gap-2">
      {/* Three segments rather than a continuous bar: a bar implies a precise
          score this cannot honestly give. */}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
                index < filled ? STRENGTH_FILL[strength] : "bg-line-2"
              }`}
            />
          ))}
        </div>
        <span
          // The meter's value in words, which is all a screen reader needs and
          // is also the honest resolution of the measurement.
          className={`text-meta font-medium uppercase tracking-wider ${
            password ? STRENGTH_TEXT[strength] : "text-fg-4"
          }`}
        >
          {password ? STRENGTH_LABEL[strength] : "—"}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {checks.map((check) => (
          <li
            key={check.label}
            className={`flex items-center gap-1.5 text-caption transition-colors duration-150 ${
              check.met ? "text-success" : "text-fg-4"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] leading-none ${
                check.met ? "border-success-line bg-success-bg" : "border-line-2"
              }`}
            >
              {check.met ? "✓" : ""}
            </span>
            <span>{check.label}</span>
            <span className="sr-only">{check.met ? " — met" : " — not yet met"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STRENGTH_FILL = {
  weak: "bg-danger",
  fair: "bg-accent",
  strong: "bg-success",
} as const;

const STRENGTH_TEXT = {
  weak: "text-danger",
  fair: "text-accent",
  strong: "text-success",
} as const;

const STRENGTH_LABEL = {
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
} as const;
