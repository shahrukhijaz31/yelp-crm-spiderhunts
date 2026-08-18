"use client";

import { usePathname } from "next/navigation";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import SessionTimer from "./SessionTimer";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import { usePortalStats } from "./PortalStatsProvider";
import type { SessionUser } from "@/lib/access";
import { type NavMode } from "@/lib/navPreference";

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
  // One lead, opened in its own tab from the worklist. Named separately so a
  // tab sitting on a lead does not claim to be the list it came from.
  ["/leads", "Lead workspace"],
  ["/meetings", "Meetings"],
  // Before `/reports`, because the first match wins and `/reports` is a prefix
  // of this one. The two are different screens: Reports is the state of the
  // lead list, this is the state of the people working it.
  ["/reports/team", "Team performance"],
  // Before `/reports` for the same reason Team performance is: the first match
  // wins, and `/reports` is a prefix of this one.
  ["/reports/app-usage", "App usage"],
  ["/reports", "Reports"],
  ["/my-performance", "My performance"],
  ["/export", "Export"],
  ["/import", "Import"],
  ["/users", "Users"],
  ["/settings", "Settings"],
  // Everything under `/account` is about the signed-in person rather than the
  // workspace, which is why it is one heading rather than a per-page title.
  ["/account", "Account"],
  ["/", "Leads workspace"],
];

/**
 * Which half of the "auto" toggle is on screen, as whole literal strings.
 *
 * `2xl:` is the breakpoint `NAV_LABEL_MIN_WIDTH` names, and the pair matches
 * `NAV_MODE_CLASSES.auto` in `lib/navPreference.ts` — above it the rail shows
 * labels and the button offers to collapse, below it the reverse. Written out
 * rather than assembled, because Tailwind finds classes by scanning source text.
 */
const RAIL_COLLAPSED_AT_THIS_WIDTH = "2xl:hidden";
const RAIL_EXPANDED_AT_THIS_WIDTH = "2xl:block";

function titleFor(pathname: string): string {
  const match = TITLES.find(([prefix]) =>
    prefix === "/" ? pathname === "/" : pathname.startsWith(prefix),
  );
  return match?.[1] ?? "Leads workspace";
}

export default function AppTopBar({
  today,
  user,
  showLeadStats = true,
  navMode = "auto",
  onOpenNav,
  onToggleNav,
}: {
  today: string;
  user: SessionUser;
  /**
   * Whether the two lead counters are drawn.
   *
   * False for an agent whose account has Demo Websites and not Leads: the
   * figures behind them are never read for such a person (see the portal
   * layout), so drawing them would put a confident `0 leads` on the bar of
   * somebody who simply is not shown the lead database. A number that is zero
   * because nobody counted is worse than no number.
   */
  showLeadStats?: boolean;
  /** The rail's current width preference, for labelling the toggle. */
  navMode?: NavMode;
  /** Opens the off-canvas sidebar. Below `md` only. */
  onOpenNav: () => void;
  /** Collapses or expands the rail, and remembers it. From `md` up. */
  onToggleNav?: () => void;
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

      {/*
       * Collapse or expand the rail. From `md` up only — below that the rail is
       * off-canvas and the button beside this one already opens it, so a second
       * control for a width nothing has would do nothing visible.
       *
       * Two icons and two labels in "auto" rather than one of each, because in
       * that mode the effective state is decided by a media query and the server
       * cannot know which side of it this browser is on. `hidden` is
       * `display: none`, which takes an element out of the accessible name
       * entirely, so exactly one of the pair ever contributes — which is what
       * lets one server-rendered button say the right thing at both widths
       * without a measurement after hydration.
       */}
      {onToggleNav && (
        <button
          type="button"
          onClick={onToggleNav}
          aria-label={
            navMode === "collapsed"
              ? "Expand the sidebar"
              : navMode === "expanded"
                ? "Collapse the sidebar"
                : undefined
          }
          title={
            navMode === "collapsed"
              ? "Expand the sidebar"
              : navMode === "expanded"
                ? "Collapse the sidebar"
                : "Collapse or expand the sidebar"
          }
          className="ui-btn ui-btn-ghost -ml-1 hidden h-8 w-8 !px-0 text-fg-3 md:inline-flex"
        >
          {navMode === "collapsed" ? (
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          ) : navMode === "expanded" ? (
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <>
              <PanelLeftOpen
                className={`h-4 w-4 ${RAIL_COLLAPSED_AT_THIS_WIDTH}`}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className={`sr-only ${RAIL_COLLAPSED_AT_THIS_WIDTH}`}>Expand the sidebar</span>
              <PanelLeftClose
                className={`hidden h-4 w-4 ${RAIL_EXPANDED_AT_THIS_WIDTH}`}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className={`sr-only hidden ${RAIL_EXPANDED_AT_THIS_WIDTH}`}>Collapse the sidebar</span>
            </>
          )}
        </button>
      )}

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
        <p
          className={`items-center gap-2 text-caption text-fg-3 ${showLeadStats ? "hidden lg:flex" : "hidden"}`}
        >
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

        {/* The shift clock, beside the two lead counts rather than anywhere
            more prominent: it is the same kind of fact, and it is the one
            number here that is about the person rather than the workspace.
         *
         * Agents only. Time tracking is a thing the portal does *to* agents and
         * reports *to* administrators — nothing reads, totals or reviews an
         * administrator's own shift, so a clock on their bar would be a number
         * with nothing behind it. The same rule drops the current-session row
         * from `UserMenu`, and the two are the whole of the clock in the shell.
         *
         * This is a label, not a permission: the work session still exists and
         * still beats, because the heartbeat is what keeps `work_sessions`
         * honest for everyone. Only the readout is role-specific. */}
        {user.role === "AGENT" && <SessionTimer />}

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
