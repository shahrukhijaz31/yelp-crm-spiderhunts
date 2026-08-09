"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/**
 * Sun/Moon toggle.
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
      className="ui-btn ui-btn-ghost h-8 w-8 !px-0"
    >
      {/* Dark theme is on: offer the sun. */}
      <span className="theme-when-dark flex">
        <Sun className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">Switch to light theme</span>
      </span>
      {/* Light theme is on: offer the moon. */}
      <span className="theme-when-light flex">
        <Moon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">Switch to dark theme</span>
      </span>
    </button>
  );
}
