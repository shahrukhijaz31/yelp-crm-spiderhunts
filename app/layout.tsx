import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";

/**
 * Two faces, two jobs.
 *
 *   Geist      — everything read as language, and the numerals in the stat
 *                strip. A neutral grotesque with a large x-height and very
 *                even colour, which is what a screen of 14px UI text needs.
 *   Geist Mono — everything read as data: phone numbers, dates, counts, page
 *                numbers, file sizes. Tabular by construction, so a column of
 *                figures lines up without `font-variant-numeric` doing the
 *                work on its own.
 *
 * This replaces a three-family stack (Fraunces / Instrument Sans / IBM Plex
 * Mono). Fraunces was the reason the old portal read as an editorial product
 * rather than a workspace: a soft, wonky display serif carrying the wordmark,
 * the page titles and every headline numeral. Two neutral faces from one
 * family is both a smaller download and a much quieter page, which is what
 * lets the data be the only thing with any personality on screen.
 */
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SpiderHunts Leads Portal",
  description: "Call list and status tracking for outbound agents",
  // `app/favicon.ico` is the same artwork, so the file convention and this
  // declaration agree — browsers that guess `/favicon.ico` and browsers that
  // read the tag both get the SpiderHunts mark.
  icons: { icon: "/logo.ico", shortcut: "/logo.ico" },
};

/**
 * The document shell, and nothing else.
 *
 * The nav bar, the lead store and the per-request database read used to live
 * here. They moved into `app/(portal)/layout.tsx` when authentication landed,
 * because a root layout wraps the login page too — and that meant every lead
 * in the database was being fetched and serialised into the HTML of a page
 * served to people who had not signed in. Nothing above the route group is
 * allowed to touch lead data for that reason.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: next-themes stamps data-theme on <html> before
    // React hydrates, so the server and client markup differ here by design.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-base text-fg">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
