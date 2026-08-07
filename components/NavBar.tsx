"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import ThemeToggle from "./ThemeToggle";
import { useLeads } from "./LeadsProvider";

/**
 * Top bar rather than a sidebar, deliberately: the worklist is an eight-column
 * table with a ~1380px minimum, so horizontal space is the scarce axis and
 * vertical space is not (rows scroll regardless). A sidebar would spend 220px
 * of exactly what the table needs; a 52px bar spends none of it.
 *
 * Three zones, left to right:
 *   BRAND     logo, wordmark, workspace badge — identity, never interactive noise
 *   TABS      the four workspaces an agent moves between all day
 *   UTILITY   live counts, theme, profile — read or poked, not navigated
 *
 * Colour comes entirely from the token set in `globals.css`, so the bar is
 * correct in both themes without naming either: `bg-surface` is #15181f on the
 * graphite theme and near-white on the slate one, and `border-line` follows.
 */

/** The primary workspaces. Order is the order of a day's work. */
const NAV = [
  { href: "/", label: "Leads Workspace" },
  { href: "/meetings", label: "Meetings" },
  { href: "/export", label: "Export Data" },
  { href: "/import", label: "Upload CSV" },
] as const;

/**
 * Kept out of the tab strip on purpose. Reports and Settings are visited
 * occasionally, not worked in, and giving them equal weight would dilute the
 * four tabs an agent actually lives in.
 */
const SECONDARY = [
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
] as const;

export default function NavBar({ today }: { today: string }) {
  const pathname = usePathname();
  const { stats } = useLeads();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Sign-in is the one route outside the workspace: there is nothing to
  // navigate to and no counts to read until you are through it, and a bar full
  // of live lead totals above a login form would be advertising the data it is
  // meant to be gating. The page brings its own brand mark and theme toggle.
  if (pathname === "/login") return null;

  return (
    <nav className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-[52px] w-full max-w-[1760px] items-stretch gap-6 px-6">
        {/* --- brand --------------------------------------------------- */}
        <Link
          href="/"
          aria-label="SpiderHunts Leads Portal — go to the leads workspace"
          className="flex shrink-0 items-center gap-2.5 self-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {/* `unoptimized`: .ico is not a format the image optimiser handles,
              and at 28px there is nothing worth optimising anyway. */}
          <Image
            src="/logo.ico"
            alt=""
            aria-hidden="true"
            width={28}
            height={28}
            unoptimized
            priority
            // Desaturated on purpose: red is the bar's one signal colour, spent
            // on the active tab and the overdue count. A full-colour mark up
            // here would compete with both.
            className="h-7 w-7 shrink-0 rounded-md object-contain grayscale"
          />
          <span className="display-num whitespace-nowrap text-[16px] leading-none text-fg">
            SpiderHunts <span className="text-fg-2">Leads Portal</span>
          </span>
        </Link>

        {/* Version and workspace state: present for orientation, pitched low
            enough that it never competes with the wordmark beside it. */}
        <span className="hidden shrink-0 items-center gap-1.5 self-center rounded-full border border-line px-2.5 py-[3px] text-[10.5px] font-medium tracking-[0.02em] text-fg-4 lg:inline-flex">
          v1.0
          <span aria-hidden="true" className="text-fg-4/50">
            •
          </span>
          Active Workspace
        </span>

        {/* --- primary tabs -------------------------------------------- */}
        <ul role="tablist" aria-label="Workspaces" className="flex items-stretch gap-0.5">
          {NAV.map((item) => {
            const active = isActive(item.href);

            return (
              <li key={item.href} className="flex">
                <Link
                  href={item.href}
                  role="tab"
                  aria-selected={active}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center whitespace-nowrap px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
                    active ? "text-fg" : "text-fg-3 hover:text-fg-2"
                  }`}
                >
                  {item.label}
                  {/* Active workspace is marked in the accent red, at the
                      bar's edge — the same signal the worklist uses for
                      time-critical rows, and the only red up here. */}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-x-1.5 bottom-0 h-[2px] rounded-t-full transition-colors ${
                      active ? "bg-accent" : "bg-transparent"
                    }`}
                  />
                </Link>
              </li>
            );
          })}
        </ul>

        {/* --- utility group ------------------------------------------- */}
        <div className="ml-auto flex items-center gap-3 self-center">
          <ul className="hidden items-center gap-0.5 xl:flex">
            {SECONDARY.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={`rounded-md px-2 py-1 text-[12.5px] transition-colors hover:text-fg ${
                    isActive(item.href) ? "text-fg" : "text-fg-4"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>

          <QuickStats
            total={stats.total}
            due={stats.callbackDueToday + stats.callbackOverdue}
          />

          <p className="hidden text-[12px] text-fg-3 2xl:block">{longDate(today)}</p>

          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

/**
 * Two live numbers, sharing one recessed pill: how much list there is, and how
 * much of it is owed a call today. Mono numerals so the digits don't shift the
 * layout as counts change through the day.
 */
function QuickStats({ total, due }: { total: number; due: number }) {
  return (
    <div className="hidden items-center gap-2.5 rounded-lg border border-line bg-recessed px-2.5 py-1 md:flex">
      <span className="flex items-baseline gap-1.5" title={`${total} leads in this workspace`}>
        <span className="tnum font-mono text-[12.5px] font-semibold leading-none text-fg">
          {total}
        </span>
        <span className="text-[10.5px] leading-none text-fg-4">leads</span>
      </span>

      <span aria-hidden="true" className="h-3 w-px bg-line" />

      {/* Red only when there is actually something owed — a permanently red
          counter is a counter an agent stops seeing. */}
      <span
        className="flex items-baseline gap-1.5"
        title={`${due} callback${due === 1 ? "" : "s"} due today or overdue`}
      >
        <span
          className={`tnum font-mono text-[12.5px] font-semibold leading-none ${
            due > 0 ? "text-accent" : "text-fg-2"
          }`}
        >
          {due}
        </span>
        <span className="text-[10.5px] leading-none text-fg-4">due</span>
      </span>
    </div>
  );
}

/** `2026-08-04` -> `Tuesday, 4 August`. */
function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
