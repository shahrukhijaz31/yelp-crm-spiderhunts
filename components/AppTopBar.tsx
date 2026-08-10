"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import { usePortalStats } from "./PortalStatsProvider";
import type { SessionUser } from "@/lib/access";

/**
 * The top bar: where you are on the left, the state of the workspace on the
 * right.
 *
 * It carries no navigation. That moved to the sidebar, and the difference is
 * the point — a bar that both names the current screen *and* offers four ways
 * to leave it has to fight itself for space, which is why the old one squeezed
 * its live counts, the date, the theme control and the profile menu into
 * whatever was left after four tabs. With navigation gone, each of those gets
 * room, and the screen's own name gets to be the first thing read.
 *
 * 52px, matching the sidebar's brand block exactly so the two hairlines meet.
 */

/** Path → the name of the screen. Longest prefix wins. */
const TITLES: Array<[string, string]> = [
  ["/meetings", "Meetings"],
  ["/reports", "Reports"],
  ["/export", "Export"],
  ["/import", "Import"],
  ["/users", "Users"],
  ["/settings", "Settings"],
  // Everything under `/account` is about the signed-in person rather than the
  // workspace, which is why it is one heading rather than a per-page title.
  ["/account", "Account"],
  ["/", "Leads workspace"],
];

function titleFor(pathname: string): string {
  const match = TITLES.find(([prefix]) =>
    prefix === "/" ? pathname === "/" : pathname.startsWith(prefix),
  );
  return match?.[1] ?? "Leads workspace";
}

export default function AppTopBar({
  today,
  user,
  onOpenNav,
}: {
  today: string;
  user: SessionUser;
  /** Opens the off-canvas sidebar. Below `md` only. */
  onOpenNav: () => void;
}) {
  const pathname = usePathname();
  // The shell's counts, not the current screen's: seeded by the layout from a
  // Postgres aggregate and refreshed by whichever route knows better.
  const { stats } = usePortalStats();
  const due = stats.callbackDueToday + stats.callbackOverdue;

  return (
    <header className="sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-base/70 px-3 backdrop-blur-xl sm:px-5">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="ui-btn ui-btn-ghost -ml-1 h-8 w-8 !px-0 md:hidden"
      >
        <Menu className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
      </button>

      <h1 className="min-w-0 truncate text-ui font-semibold tracking-[-0.015em] text-fg">
        {titleFor(pathname)}
      </h1>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
        {/*
         * Two live numbers. Plain text on the bar rather than in a bordered
         * pill: at this size a pill is a box around two words, and the bar
         * already has a rule under it doing the containing.
         *
         * Red only when something is actually owed — a permanently red counter
         * is a counter an agent stops seeing.
         */}
        <p className="hidden items-center gap-2 text-caption text-fg-3 lg:flex">
          <span title={`${stats.total} leads in this workspace`}>
            <span className="tnum font-mono font-medium text-fg-2">
              {stats.total.toLocaleString()}
            </span>{" "}
            leads
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-line-2" />
          <span title={`${due} callback${due === 1 ? "" : "s"} due today or overdue`}>
            <span
              className={`tnum font-mono font-medium ${due > 0 ? "text-accent" : "text-fg-2"}`}
            >
              {due}
            </span>{" "}
            due
          </span>
        </p>

        <p className="hidden text-caption text-fg-3 2xl:block">{longDate(today)}</p>

        <span aria-hidden="true" className="hidden h-4 w-px bg-line lg:block" />

        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

/** `2026-08-04` -> `Tue, 4 Aug`. */
function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
