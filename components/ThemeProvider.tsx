"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Client boundary for next-themes.
 *
 * `attribute="data-theme"` matches the `:root[data-theme="…"]` blocks in
 * globals.css. next-themes injects a blocking script that stamps the attribute
 * before first paint, so a returning agent never sees a flash of the wrong
 * theme, and it persists the choice to localStorage under `lead-portal-theme`.
 *
 * System preference is deliberately off: this is a shared office tool where the
 * dark worklist is the house style, and an agent's OS setting shouldn't quietly
 * change what their colleagues see over their shoulder.
 */
export default function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="dark"
      themes={["dark", "light"]}
      enableSystem={false}
      storageKey="lead-portal-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
