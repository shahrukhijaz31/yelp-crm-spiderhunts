"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  BarChart3,
  CalendarDays,
  Inbox,
  PhoneOutgoing,
  Settings,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useLeadQueue } from "./LeadQueueProvider";
import { canAccess, type Role } from "@/lib/access";
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
];

/** Bulk data movement, and the read-only view of it. Admin-only, all three. */
const DATA: NavItem[] = [
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/export", label: "Export", icon: ArrowDownToLine },
  { href: "/import", label: "Import", icon: Upload },
];

/** Administration. Visited occasionally, not worked in. */
const ADMIN: NavItem[] = [
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function AppSidebar({
  role,
  /** Mobile only: the drawer is open. Ignored from `md` up. */
  onNavigate,
}: {
  role: Role;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { workState, setWorkState, counts } = useLeadQueue();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

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
      items: group.items.filter((item) => canAccess(role, item.href)),
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
          <span className="min-w-0 truncate text-ui font-semibold tracking-[-0.02em] text-fg 2xl:block max-2xl:hidden">
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
            <p className="eyebrow px-2 pb-1 max-2xl:hidden">Leads</p>
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
                  className="nav-item w-full max-2xl:justify-center max-2xl:px-0"
                >
                  <Icon className="nav-icon h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span className="truncate max-2xl:sr-only">{label}</span>
                  {/* Pushed to the trailing edge and quiet: a number you glance
                      at while scanning the rail, not a badge demanding action.
                      Gone on the icon rail, where it would not fit and is
                      already in the tooltip. */}
                  <span className="nav-count max-2xl:hidden">
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
            <p className="eyebrow px-2 pb-1 max-2xl:hidden">{group.heading}</p>
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
                  className="nav-item max-2xl:justify-center max-2xl:px-0"
                >
                  <Icon className="nav-icon h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span className="truncate max-2xl:sr-only">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* --- footer ------------------------------------------------------ */}
      <div className="shrink-0 border-t border-line px-3 py-2.5 max-2xl:hidden">
        <p className="flex items-center gap-2 text-meta text-fg-3">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
          />
          <span className="font-mono">v1.0</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">Active workspace</span>
        </p>
      </div>
    </div>
  );
}
