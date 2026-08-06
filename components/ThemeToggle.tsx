"use client";

import { useTheme } from "next-themes";

/**
 * Sun/Moon toggle for the nav bar.
 *
 * Which icon shows is decided in CSS from `:root[data-theme]`, not from React
 * state — so there is no `mounted` guard, no hydration mismatch, and no
 * first-paint flicker of the wrong glyph. React is only involved on click.
 */
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  function toggle() {
    // Read the DOM as the fallback: on the very first click after hydration
    // `resolvedTheme` may not have settled yet, but the attribute always has.
    const current =
      resolvedTheme ??
      document.documentElement.getAttribute("data-theme") ??
      "dark";
    setTheme(current === "dark" ? "light" : "dark");
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title="Switch between the dark and light theme"
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-fg-3 transition-colors hover:border-line-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {/* Dark theme is on: offer the sun. */}
      <span className="theme-when-dark">
        <SunIcon />
        <span className="sr-only">Switch to light theme</span>
      </span>
      {/* Light theme is on: offer the moon. */}
      <span className="theme-when-light">
        <MoonIcon />
        <span className="sr-only">Switch to dark theme</span>
      </span>
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[15px] w-[15px]">
      <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M14.8 8h-1.6M2.8 8H1.2M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1M12.8 12.8l-1.1-1.1M4.3 4.3 3.2 3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[15px] w-[15px]">
      <path
        d="M13.4 9.9A5.8 5.8 0 0 1 6.1 2.6a5.9 5.9 0 1 0 7.3 7.3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
