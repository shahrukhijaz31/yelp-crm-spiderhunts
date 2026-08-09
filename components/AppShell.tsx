"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";

import AppSidebar from "./AppSidebar";
import AppTopBar from "./AppTopBar";
import type { SessionUser } from "@/lib/access";

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
 * All three are CSS. Only the phone drawer is stateful, and its state is
 * deliberately not persisted — a drawer that remembers it was open is a drawer
 * covering your screen when you come back.
 */
export default function AppShell({
  today,
  user,
  children,
}: {
  today: string;
  user: SessionUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

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
      <aside className="sticky top-0 hidden h-screen w-[60px] shrink-0 border-r border-line md:block 2xl:w-[240px]">
        <AppSidebar role={user.role} />
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
            <AppSidebar role={user.role} onNavigate={() => setNavOpen(false)} />
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
        <AppTopBar today={today} user={user} onOpenNav={() => setNavOpen(true)} />
        {children}
      </div>
    </div>
  );
}
