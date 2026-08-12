"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  BarChart3,
  CalendarDays,
  ClipboardList,
  Clock,
  Gauge,
  Inbox,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneOutgoing,
  Settings,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useLeadQueue } from "./LeadQueueProvider";
import { canAccess, type Role } from "@/lib/access";
import { NAV_MODE_CLASSES, type NavMode } from "@/lib/navPreference";
import {
  LEAD_WORK_STATES,
  LEAD_WORK_STATE_LABELS,
  type LeadWorkState,
} from "@/lib/workState";

/**
 * The workspace navigation.
 *
 * **Why a sidebar now.** This used to be a top bar with four tabs, on the
 * argument that the worklist is a ~1460px table and horizontal space is the
 * scarce axis. That argument was right about the constraint and wrong about the
 * cost: the table already scrolls sideways on anything under 1460px, so a rail
 * only widens a window that was already scrolling — and in exchange the
 * navigation gets room to say what it actually is. Four flat tabs could not
 * show that Reports, Users and Settings are a different *kind* of destination
 * from the call list, so they were exiled to a smaller row of links that only
 * appeared above 1280px. Here they are simply a second group with a heading.
 *
 * It also collapses honestly: 240px of labels above 1536px, a 60px icon rail
 * below that, and off-canvas behind a button on a tablet or phone. The old bar
 * had no answer for narrow screens except hiding links.
 *
 * Those widths are the default rather than the rule — the control in the footer
 * collapses and expands the rail by hand, and that choice then holds at every
 * width. `mode` carries it in, and `NAV_MODE_CLASSES` is where each mode's
 * effect on a label, a heading and a row is written down. A label removed by
 * the icon rail goes `sr-only` rather than `hidden`: it stays in the accessible
 * name, so the rail is still navigable by screen reader.
 *
 * **The active state** is a filled rounded rect, not a red underline. An
 * underline says "this is the page you are on"; a filled row says "you are
 * inside this section", which is what a workspace means. The accent appears
 * once inside it — on the icon — so red stays a punctuation mark rather than
 * becoming a highlight colour.
 *
 * Items a role cannot reach are not drawn. That is tidiness, not security: the
 * same policy (`canAccess`) is enforced again by every page and every API route
 * against the session in Postgres, so typing the URL by hand gets an agent an
 * Access Denied screen rather than the page.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Which roles this row is drawn for. Absent means everybody who can reach it.
   *
   * A second filter beside `canAccess`, because the two answer different
   * questions. `canAccess` is the access policy and can only say "administrators
   * only" — it is a list of admin prefixes, and there is deliberately no such
   * thing as an agent-only *path* in this application. This says something
   * weaker and purely visual: the row is not useful to that role, so it is not
   * drawn for them.
   *
   * Nothing here is a permission, in either direction. A page listed for agents
   * only is still reachable by an administrator who types the URL, and should
   * be — see the note on My performance below.
   */
  roles?: readonly Role[];
}

/**
 * The two lead queues, as rail items.
 *
 * They used to be a segmented control inside the worklist panel. They are here
 * instead because that is what they actually are: New and Called are not two
 * ways of looking at one list — they are two lists, and picking between them is
 * the same kind of decision as picking the worklist over the agenda. In the
 * rail they are also visible from every screen, so an agent on Meetings can see
 * how many leads are still waiting to be called.
 *
 * Both point at `/`; the queue itself is app state, held by `LeadQueueProvider`
 * for the shell (see the note there on why it is not a URL parameter). The icons
 * are what makes them survive the 60px icon rail, where labels are gone.
 */
const QUEUE_ICONS: Record<LeadWorkState, LucideIcon> = {
  new: Inbox,
  called: PhoneOutgoing,
};

/** The workspaces an agent moves between all day. Order is a day's work. */
const WORKSPACE: NavItem[] = [
  { href: "/meetings", label: "Meetings", icon: CalendarDays },
  /*
   * An agent's own figures, and drawn for agents only.
   *
   * Not because an administrator may not see them — the page and its endpoint
   * query the session's own id and take none from the request, so an
   * administrator opening `/my-performance` gets their own record exactly as an
   * agent does, and that still works if they type the URL. It is that the row is
   * noise in an administrator's rail: they have Team performance three rows
   * below, which is the same figures for everybody including themselves, and two
   * entries that differ only in scope invite the reading that one of them is the
   * other's summary.
   *
   * `lib/access.ts` is deliberately unchanged. It says who *may* reach a path,
   * and the answer for this one is genuinely "every role" — a nav list is the
   * right place for "who is this useful to", and the wrong place for a rule
   * anyone could sidestep with the address bar.
   */
  { href: "/my-performance", label: "My performance", icon: Gauge, roles: ["AGENT"] },
  // Same rule and the same reasoning as My performance above: an agent's own
  // clock, with the administrator's view of everybody's — Time tracking and
  // Timesheets — sitting in the Data group below.
  { href: "/time-tracking", label: "My time", icon: Clock, roles: ["AGENT"] },
];

/** Bulk data movement, and the read-only view of it. Admin-only, all four. */
const DATA: NavItem[] = [
  { href: "/reports", label: "Reports", icon: BarChart3 },
  // Admin-only by virtue of `/reports` being an admin prefix, which `canAccess`
  // below applies to every item in this list. The page and its API refuse an
  // agent independently — hiding a link is not what keeps anyone out.
  { href: "/reports/team", label: "Team performance", icon: Gauge },
  // Both admin-only by virtue of the `/reports` prefix, which `canAccess`
  // applies to every item in this list. Time tracking is the live board; the
  // timesheet is the period report behind it.
  { href: "/reports/time", label: "Time tracking", icon: Clock },
  { href: "/reports/timesheets", label: "Timesheets", icon: ClipboardList },
  { href: "/export", label: "Export", icon: ArrowDownToLine },
  { href: "/import", label: "Import", icon: Upload },
];

/** Administration. Visited occasionally, not worked in. */
const ADMIN: NavItem[] = [
  /*
   * Workforce monitoring rather than lead data, which is why it is here and not
   * in Data beside Reports — the group above is about the lead database, and
   * this screen never touches one.
   *
   * Admin-only by virtue of `/screenshots` being an admin prefix, which
   * `canAccess` below applies to every item in this list, so an agent is never
   * shown it. That is tidiness. The page refuses an agent independently
   * (`requireRole`), and so does every endpoint behind it (`apiAdmin`) —
   * deleting this line would change nothing about who can see a screenshot.
   */
  { href: "/screenshots", label: "Screenshots", icon: Monitor },
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

/**
 * Every destination in the rail, for the "most specific match wins" rule in
 * `isActive`. Derived rather than written out, so a nav item added above is
 * automatically considered — a hand-kept second list is one that goes stale the
 * first time somebody adds a nested route.
 */
const NAV_HREFS: readonly string[] = [...WORKSPACE, ...DATA, ...ADMIN].map(
  (item) => item.href,
);

export default function AppSidebar({
  role,
  /** Mobile only: the drawer is open. Ignored from `md` up. */
  onNavigate,
  mode = "auto",
  /** Absent in the phone drawer, which is always full width and never collapses. */
  onToggleCollapsed,
}: {
  role: Role;
  onNavigate?: () => void;
  mode?: NavMode;
  onToggleCollapsed?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { workState, setWorkState, counts } = useLeadQueue();

  // What this mode does to a label, a heading and a nav row. See the note on
  // NAV_MODE_CLASSES for why these are whole literal strings.
  const style = NAV_MODE_CLASSES[mode];

  /**
   * Which row is lit — the *most specific* item that matches, not every item
   * whose href is a prefix of the path.
   *
   * That distinction arrived with `/reports/team`. A plain `startsWith` lights
   * Reports and Team performance together on the team screen, which tells an
   * admin they are in two places at once. Matching on a segment boundary also
   * stops a future `/reports-archive` from lighting `/reports`.
   */
  const isActive = (href: string) => {
    const matches = (candidate: string) =>
      candidate === "/"
        ? pathname === "/"
        : pathname === candidate || pathname.startsWith(`${candidate}/`);

    if (!matches(href)) return false;

    return !NAV_HREFS.some(
      (candidate) => candidate.length > href.length && matches(candidate),
    );
  };

  /**
   * Pick a queue, and make sure the leads workspace is on screen to show it.
   *
   * `router.push` only when we are not already there: from Meetings this is a
   * navigation, from the worklist it is a state change the open screen answers
   * with one bounded fetch. Pushing `/` unconditionally would re-render the
   * whole screen from the server every time an agent switched queue.
   *
   * `onNavigate` closes the phone drawer. `AppShell` closes it on a path
   * change, which does not happen when the queue is switched from the worklist
   * itself — so it is called here rather than left to the route.
   */
  function chooseQueue(next: LeadWorkState) {
    setWorkState(next);
    if (pathname !== "/") router.push("/");
    onNavigate?.();
  }

  const groups = [
    { heading: "Workspace", items: WORKSPACE },
    { heading: "Data", items: DATA },
    { heading: "Admin", items: ADMIN },
  ]
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          canAccess(role, item.href) && (item.roles === undefined || item.roles.includes(role)),
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    // Translucent over the document atmosphere rather than an opaque slab: the
    // rail picks up the warm light at the foot of the page and the cool at the
    // head, which is what stops a 240px column of flat grey from reading as a
    // cut-out beside the content.
    <div className="flex h-full flex-col bg-recessed/70 backdrop-blur-xl">
      {/* --- brand ------------------------------------------------------- */}
      {/* 52px, matching the top bar beside it exactly, so the two rules meet
          in one continuous line across the whole application. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-3 2xl:px-4">
        <Link
          href="/"
          onClick={onNavigate}
          aria-label="SpiderHunts Leads Portal — go to the leads workspace"
          className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
        >
          {/* `unoptimized`: .ico is not a format the image optimiser handles,
              and at this size there is nothing worth optimising anyway.
              `grayscale` matches the sign-in screen — the mark is the same
              object in both places and must not change colour between them. */}
          <Image
            src="/logo.ico"
            alt=""
            aria-hidden="true"
            width={26}
            height={26}
            unoptimized
            priority
            className="h-[26px] w-[26px] shrink-0 rounded object-contain grayscale"
          />
          <span className={`min-w-0 truncate text-ui font-semibold tracking-[-0.02em] text-fg ${style.hide}`}>
            SpiderHunts
          </span>
        </Link>
      </div>

      {/* --- groups ------------------------------------------------------ */}
      <nav
        aria-label="Workspace"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-4 2xl:px-3"
      >
        {/* --- the two lead queues ---------------------------------------- */}
        {/* First in the rail because they are the day's work. Buttons rather
            than links: they go to the same place and differ in what is shown
            there, so a `href` would be a lie and a middle-click would promise
            a second tab that opened on the wrong queue. */}
        {canAccess(role, "/") && (
          <div className="flex flex-col gap-1">
            <p className={`eyebrow px-2 pb-1 ${style.hide}`}>Leads</p>
            {LEAD_WORK_STATES.map((candidate) => {
              // Only lit while the worklist is actually on screen. On Meetings
              // these are a way *back* to a queue, not a description of what is
              // in front of you, and a highlight there would say otherwise.
              const active = pathname === "/" && workState === candidate;
              const Icon = QUEUE_ICONS[candidate];
              const label = LEAD_WORK_STATE_LABELS[candidate];
              const count = counts[candidate];

              return (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => chooseQueue(candidate)}
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                  // The count joins the accessible name: on the icon rail the
                  // whole row is a tooltip, and "New, 843 leads" is the useful
                  // form of it.
                  title={`${label} — ${count} lead${count === 1 ? "" : "s"}`}
                  className={`nav-item w-full ${style.center}`}
                >
                  <Icon className="nav-icon h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span className={`truncate ${style.srOnly}`}>{label}</span>
                  {/* Pushed to the trailing edge and quiet: a number you glance
                      at while scanning the rail, not a badge demanding action.
                      Gone on the icon rail, where it would not fit and is
                      already in the tooltip. */}
                  <span className={`nav-count ${style.hide}`}>
                    {count.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.heading} className="flex flex-col gap-1">
            {/* The heading is what a flat list of tabs could never say: these
                three are a different kind of thing from those two. Hidden on
                the icon rail, where there is no room for a word and the
                grouping is carried by the gap between blocks instead. */}
            <p className={`eyebrow px-2 pb-1 ${style.hide}`}>{group.heading}</p>
            {group.items.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                  // On the icon rail the label is gone from the page but not
                  // from the accessible name — `title` gives a tooltip and the
                  // text stays in the DOM for a screen reader.
                  title={item.label}
                  className={`nav-item ${style.center}`}
                >
                  <Icon className="nav-icon h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span className={`truncate ${style.srOnly}`}>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* --- footer ------------------------------------------------------ */}
      {/* The collapse control lives here rather than in the nav list above,
          because it is chrome and not a destination — a row that looks like
          Meetings and Reports but goes nowhere is the one thing a rail this
          legible should not contain. The version line beside it is the first
          thing to go when there is no room for it. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2.5">
        <p className={`flex min-w-0 items-center gap-2 text-meta text-fg-3 ${style.hide}`}>
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
          />
          <span className="font-mono">v1.0</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">Active workspace</span>
        </p>

        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            /*
             * Two icons and two labels rather than one of each, because in
             * "auto" the effective state is decided by a media query and the
             * server cannot know which side of it this browser is on. Letting
             * CSS choose keeps the button honest at every width without a
             * measurement that would have to happen after hydration — and in
             * the two explicit modes only one of the pair is ever rendered.
             */
            aria-label={
              mode === "collapsed"
                ? "Expand the sidebar"
                : mode === "expanded"
                  ? "Collapse the sidebar"
                  : // Left to the labels below in "auto", where which of the two
                    // this is depends on a media query. An `aria-label` is one
                    // string and would have to guess.
                    undefined
            }
            title={
              mode === "collapsed"
                ? "Expand the sidebar"
                : mode === "expanded"
                  ? "Collapse the sidebar"
                  : "Collapse or expand the sidebar"
            }
            className="ui-btn ui-btn-ghost ml-auto h-7 w-7 shrink-0 !px-0 text-fg-3 max-2xl:mx-auto"
          >
            {mode === "collapsed" ? (
              <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            ) : mode === "expanded" ? (
              <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              /*
               * The accessible name comes from whichever of these two is
               * displayed: `hidden` is `display: none`, which takes an element
               * out of the accessible name entirely, so exactly one of them
               * ever contributes. That is what lets one server-rendered button
               * say the right thing on both sides of the breakpoint.
               */
              <>
                <PanelLeftOpen
                  className="h-4 w-4 2xl:hidden"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="sr-only 2xl:hidden">Expand the sidebar</span>
                <PanelLeftClose
                  className="hidden h-4 w-4 2xl:block"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="sr-only hidden 2xl:block">Collapse the sidebar</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
