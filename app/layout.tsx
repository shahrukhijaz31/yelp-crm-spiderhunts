import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { connection } from "next/server";

import "./globals.css";
import NavBar from "@/components/NavBar";
import ThemeProvider from "@/components/ThemeProvider";
import { LeadsProvider } from "@/components/LeadsProvider";
import { listLeads } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";

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

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Lead data is read per request, not baked at build time: the worklist is
  // live data, and callback highlighting is relative to "now".
  await connection();
  const today = todayIso();
  const leads = await listLeads();

  return (
    // suppressHydrationWarning: next-themes stamps data-theme on <html> before
    // React hydrates, so the server and client markup differ here by design.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fraunces.variable} ${instrumentSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-base text-fg">
        <ThemeProvider>
          {/* One store for every route: /import loads a CSV that / then shows. */}
          <LeadsProvider initialLeads={leads} serverToday={today}>
            <NavBar today={today} />
            {children}
          </LeadsProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}