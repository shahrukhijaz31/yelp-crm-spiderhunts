"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";

import AppSidebar from "./AppSidebar";
import AppTopBar from "./AppTopBar";
import type { SessionUser } from "@/lib/access";
import { ADMIN_MODULE_ACCESS, type ModuleAccess } from "@/lib/modules";
import {
  NAV_LABEL_MIN_WIDTH,
  NAV_MODE_CLASSES,
  NAV_MODE_COOKIE,
  NAV_MODE_MAX_AGE,
  type NavMode,
} from "@/lib/navPreference";

/**
 * The application frame: a rail down the left, a bar across the top of what is
 * left, and the screen underneath it.
 *
 * Three widths, and they are chosen by the table this shell mostly contains:
 *
 *   ≥1536px   240px of sidebar with labels. The worklist needs ~1460px and
 *             gets it, so nothing is traded at the size most agents work at.
 *   768–1535   a 60px icon rail. The table is already scrolling sideways at
 *             this width, so the rail costs nothing that was not already lost,
 *             and navigation stays permanently on screen.
 *   <768px     off-canvas behind a button, over a scrim.
 *
 * Those three are the **default**, and they are still what an account that has
 * never touched the control gets. The rail is also collapsible by hand, and an
 * explicit choice then wins at every width from `md` up — including the ones
 * where the automatic behaviour would have decided otherwise, because a
 * preference that quietly refused below a breakpoint would be a control that
 * does nothing. See `lib/navPreference.ts` for the three modes.
 *
 * That choice arrives from the server as a cookie and is *not* read from
 * `localStorage`, which could only be consulted after hydration — the rail would
 * paint at one width and snap to the other on every page load. The phone drawer
 * is the one piece of state deliberately **not** persisted: a drawer that
 * remembers it was open is a drawer covering your screen when you come back.
 */
export default function AppShell({
  today,
  user,
  access = ADMIN_MODULE_ACCESS,
  navMode: initialNavMode = "auto",
  children,
}: {
  today: string;
  user: SessionUser;
  /**
   * Which modules this account may reach. Passed straight through to the rail,
   * which is the only thing in the shell that cares — and which uses it to
   * decide what to *draw*, never what to allow. See `AppSidebar`.
   */
  access?: ModuleAccess;
  /** The rail's persisted width preference, read from the cookie by the layout. */
  navMode?: NavMode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [navMode, setNavMode] = useState<NavMode>(initialNavMode);

  /**
   * Collapse or expand, and remember it.
   *
   * From "auto" this has to ask the viewport which way round it currently is,
   * because that is the one mode whose appearance is decided by a media query.
   * Doing it here rather than during render is what keeps it safe: this runs in
   * a click handler, long after hydration, so it cannot make the server and the
   * browser disagree about the first paint.
   *
   * The cookie is written from here rather than through an endpoint. It gates
   * nothing and names nobody — the worst a bad value can do is give somebody
   * their own sidebar at the other width — so a round trip would buy nothing.
   * `SameSite=Lax` because there is no reason for it to travel cross-site, and
   * no `Secure` flag because development is plain http and the value is not a
   * secret in either environment.
   */
  function toggleNav() {
    const showingLabels =
      navMode === "expanded" ||
      (navMode === "auto" &&
        typeof window !== "undefined" &&
        window.matchMedia(`(min-width: ${NAV_LABEL_MIN_WIDTH}px)`).matches);

    const next: NavMode = showingLabels ? "collapsed" : "expanded";
    setNavMode(next);
    document.cookie = `${NAV_MODE_COOKIE}=${next}; path=/; max-age=${NAV_MODE_MAX_AGE}; samesite=lax`;
  }

  // Navigating closes the drawer. Without this, tapping a link on a phone
  // loads the new screen behind a sidebar that is still covering it — and the
  // back button does the same thing without ever touching a link, which is why
  // this watches the path rather than living in the link's onClick.
  //
  // Adjusted during render rather than in an effect: the drawer and the new
  // route then land in one commit, so there is no frame where the new screen
  // is painted with the old drawer still over it.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setNavOpen(false);
  }

  // Escape closes it, and while it is open the page behind must not scroll —
  // a scrim you can scroll through is a scrim that does not read as modal.
  useEffect(() => {
    if (!navOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setNavOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [navOpen]);

  return (
    <div className="flex min-h-full flex-1">
      {/* --- rail (md and up) -------------------------------------------- */}
      {/* `sticky` with its own scroll, so a long nav scrolls independently of
          the page and the brand block never leaves the top of the screen. */}
      {/* The width transitions rather than jumping: this is a deliberate act by
          the reader, and 180px of layout appearing between two frames reads as
          a glitch rather than as the thing they just asked for. */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-r border-line transition-[width] duration-200 ease-out md:block ${NAV_MODE_CLASSES[navMode].width}`}
      >
        <AppSidebar role={user.role} access={access} mode={navMode} />
      </aside>

      {/* --- drawer (below md) ------------------------------------------- */}
      {navOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="absolute inset-0 cursor-default bg-base/70 backdrop-blur-[2px]"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="pop-in absolute inset-y-0 left-0 w-[264px] border-r border-line shadow-e3 [--pop-origin:left_center]"
          >
            {/* Always full width, and never collapsible: the drawer is 264px of
                deliberately-opened navigation, so there is nothing to save by
                narrowing it and no rail for it to become.

                `mode="expanded"` also fixes a real bug rather than merely
                configuring one. The labels used to be hidden by `max-2xl:`
                classes, which are true on a phone — so the drawer opened 264px
                wide showing nothing but a column of icons. */}
            <AppSidebar
              role={user.role}
              access={access}
              mode="expanded"
              onNavigate={() => setNavOpen(false)}
            />
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="Close navigation"
              className="ui-btn ui-btn-ghost absolute right-2 top-2.5 h-8 w-8 !px-0"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* --- content ----------------------------------------------------- */}
      {/* `min-w-0` is load-bearing: without it the worklist's 1460px table
          forces this flex child to that width and the whole page scrolls
          sideways instead of just the table. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The rail's collapse control lives up here rather than in the
            sidebar's own footer. It is the same `toggleNav` and the same
            cookie — what moved is where the reader reaches for it: beside the
            drawer button it replaces below `md`, at the top of the screen
            rather than at the bottom of a column they may have scrolled. One
            control, so there is no second one to disagree with it. */}
        <AppTopBar
          today={today}
          user={user}
          // The lead counters belong to the Leads module. An account without it
          // is never shown them — see the note on `showLeadStats`.
          showLeadStats={access.leads}
          navMode={navMode}
          onOpenNav={() => setNavOpen(true)}
          onToggleNav={toggleNav}
        />
        {children}
      </div>
    </div>
  );
}
