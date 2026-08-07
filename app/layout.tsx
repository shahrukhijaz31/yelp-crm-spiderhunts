import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";

import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";

/**
 * Three faces, three jobs:
 *   Fraunces        — display: the wordmark and the headline stat numerals.
 *   Instrument Sans — everything read as language.
 *   IBM Plex Mono   — everything read as data (phones, dates, counts).
 */
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
      className={`${fraunces.variable} ${instrumentSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-base text-fg">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
