"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowDownToLine,
  BarChart3,
  CalendarDays,
  Settings,
  Table2,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

import { canAccess, type Role } from "@/lib/access";

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

/** The workspaces an agent moves between all day. Order is a day's work. */
const WORKSPACE: NavItem[] = [
  { href: "/", label: "Leads", icon: Table2 },
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

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

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
              and at 22px there is nothing worth optimising anyway. */}
          <Image
            src="/logo.ico"
            alt=""
            aria-hidden="true"
            width={22}
            height={22}
            unoptimized
            priority
            className="h-[22px] w-[22px] shrink-0 rounded object-contain"
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
        <p className="flex items-center gap-2 text-meta text-fg-4">
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
