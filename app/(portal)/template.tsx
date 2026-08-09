/**
 * The transition between workspace screens.
 *
 * A `template` rather than a `layout`, and that is the entire mechanism: Next
 * remounts a template on every navigation while a layout persists, so the CSS
 * animation below actually replays each time somebody moves between Leads,
 * Meetings, Reports and the rest. In a layout it would run once, on first
 * load, and never again.
 *
 * **A server component, animating in CSS.** The obvious implementation is a
 * `motion.div` with an `initial` opacity — and that would server-render every
 * screen in this app at `opacity: 0`, waiting for JavaScript to reveal it. A
 * CSS animation on a remounted element replays exactly the same way, needs no
 * client boundary around every page, ships no JavaScript, and if the
 * stylesheet ever fails to load the failure mode is "unstyled but visible"
 * rather than "blank".
 *
 * Deliberately small — 4px and 180ms (see `.page-enter`). A page transition on
 * an internal tool exists to absorb the moment where a server component is
 * streaming in, so the new screen arrives rather than snapping. There is no
 * exit animation: waiting for the old screen to leave before the new one
 * starts would double the cost of every click in the sidebar.
 *
 * `min-w-0` and the flex chain are load-bearing, not cosmetic. This div sits
 * between the shell's content column and each screen's `<main>`, so without
 * them the worklist's 1460px table would size this wrapper and the whole page
 * would scroll sideways instead of just the table.
 */
export default function PortalTemplate({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-enter flex min-h-0 w-full min-w-0 flex-1 flex-col">
      {children}
    </div>
  );
}
