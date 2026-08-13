"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, KeyRound, LogOut, MonitorDown } from "lucide-react";

import { useWorkSession } from "./WorkSessionProvider";
import { LOGIN_PATH, type SessionUser } from "@/lib/access";
import { formatWorkClock } from "@/lib/performanceRules";

/**
 * The signed-in user, at the right-hand end of the top bar.
 *
 * The user object is rendered by the server from the session row in Postgres
 * and passed down as a prop. Nothing here reads localStorage, and the role
 * shown is a label: no code anywhere decides what is permitted from this
 * value, so a user who edits it in devtools sees a different word and gains
 * exactly nothing.
 *
 * Keyboard behaviour is hand-rolled rather than borrowed from a primitives
 * library, because there is exactly one menu in this application and it is
 * three items long. Down-arrow from the trigger opens it and lands on the first item,
 * Escape closes and returns focus to the trigger, and Tab out closes it. That
 * is the whole `menu` pattern for a menu this size.
 *
 * "Change password" is a link to a page, not a dialog. It was a dialog first,
 * and the form turned out to be too tall for one: three fields, a strength
 * meter, a requirements list and room for an error banner is more than a modal
 * can hold on a laptop without running off the top of the window. The page it
 * points at has the whole column, and an address someone can be told over the
 * phone.
 */
export default function UserMenu({ user }: { user: SessionUser }) {
  const router = useRouter();
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Click-away and Escape. Both listeners are only attached while the menu is
  // open, so a closed menu costs nothing.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onFocusIn(event: FocusEvent) {
      // Tabbing past the last item leaves the menu; it should not stay open
      // behind whatever now has focus.
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  // Opening with the keyboard should land on the first item, the way every
  // other menu on the machine does.
  useEffect(() => {
    if (open) itemRef.current?.focus();
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      // The server deletes the session row and clears the cookie. The client
      // is only responsible for going somewhere afterwards.
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the request failed, leave. The next protected page will do the
      // check properly, and stranding someone on a screen they asked to leave
      // is worse than an extra redirect.
    }
    // `replace`, so Back does not return to a portal page as the first entry
    // in history. `refresh` throws away the cached server render of the
    // authenticated shell — without it, going Back can paint the old shell
    // (with no data behind it) before the redirect happens.
    router.replace(LOGIN_PATH);
    router.refresh();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        title={`${user.name} — ${ROLE_LABELS[user.role]}`}
        className={`flex h-8 items-center gap-1.5 rounded-md pl-1 pr-1.5 transition-colors ${
          open ? "bg-hover text-fg" : "text-fg-2 hover:bg-hover hover:text-fg"
        }`}
      >
        <Initials name={user.name} />
        <span className="hidden max-w-[120px] truncate text-caption font-medium xl:block">
          {user.name}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-fg-4 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>

      {/*
       * Opens on a spring from its own top-right corner, so the menu appears
       * to grow out of the button rather than fade in over it, and closes on a
       * short ease — an exit that springs reads as indecision.
       *
       * `AnimatePresence` is what makes the close animate at all: React would
       * otherwise unmount the node the instant `open` flips.
       */}
      <AnimatePresence>
        {open && (
          <motion.div
            id={menuId}
            role="menu"
            aria-label="Account"
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.6 }}
            style={{ transformOrigin: "top right" }}
            className="panel-float absolute right-0 top-[calc(100%+6px)] z-40 w-64 overflow-hidden p-1"
          >
          <div className="flex items-start gap-2.5 px-2 py-2">
            <Initials name={user.name} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui font-medium leading-tight text-fg">
                {user.name}
              </p>
              <p className="mt-0.5 truncate text-caption leading-tight text-fg-3">
                {user.email}
              </p>
            </div>
            <RoleBadge role={user.role} />
          </div>

          <div aria-hidden="true" className="my-1 h-px bg-line" />

          {/*
           * The current session, in the one place it is genuinely wanted.
           *
           * It is not in the top bar, where it sat beside the day's total and
           * the two were indistinguishable — see the note in `SessionTimer`.
           * Here it is directly above Sign out, which is the moment somebody
           * actually asks "how long has this session been": they have opened
           * this menu in order to leave. The rest of the day it costs nothing,
           * because the menu is shut.
           *
           * A row of text, not a menu item: there is nothing to activate, so it
           * takes no `role="menuitem"` and no focus stop. Keyboard users tab
           * straight from the trigger to Change password as before.
           */}
          <SessionRow />

          <Link
            ref={itemRef}
            href="/account/password"
            role="menuitem"
            // The menu must not survive the navigation: it is fixed to the top
            // bar, which stays mounted across routes, so it would otherwise
            // still be hanging open over the page it just sent you to.
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-ui text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg"
          >
            <KeyRound className="h-4 w-4 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />
            Change password
          </Link>

          {/*
           * The desktop software, beside the other thing about your own account
           * rather than in the rail.
           *
           * It is here and not in the sidebar because of how often it is
           * wanted: an agent downloads the Monitor once, on their first day,
           * and never again — a permanent row in the navigation would be a
           * destination nobody visits twice, sitting above the queues they use
           * all day. This menu is already where "things about me" live, and the
           * page has an address (`/downloads`) that an administrator can say
           * over the phone.
           *
           * Drawn for both roles, and that is not a permission: `/downloads` is
           * not an admin prefix, and the page and both endpoints behind it
           * resolve the session from Postgres themselves.
           */}
          <Link
            href="/downloads"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-ui text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg"
          >
            <MonitorDown className="h-4 w-4 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />
            Download Monitor
          </Link>

          <button
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-ui text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            <LogOut className="h-4 w-4 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The running shift: how long, and since when.
 *
 * Reads the same `WorkSessionProvider` the top bar does, so the figure here and
 * the day's total there are two views of one clock rather than two clocks. The
 * start instant comes from the `work_sessions` row in Postgres — the browser
 * only counts forward from it, which is why this survives a refresh and agrees
 * between tabs.
 *
 * Renders nothing when no session is running. There is no state in which this
 * should show a stopped clock: a person reading this menu is signed in, and if
 * the row is somehow missing, saying nothing is better than saying zero.
 */
function SessionRow() {
  const { startedAt, currentSessionSeconds } = useWorkSession();

  if (!startedAt || currentSessionSeconds === null) return null;

  const since = new Date(startedAt).toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="pulse-ring absolute inset-0 rounded-full bg-success" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-caption text-fg-2">Current session</span>
            <span className="block truncate text-meta text-fg-4">Signed in at {since}</span>
          </span>
        </span>
        <span className="tnum shrink-0 font-mono text-caption font-medium text-fg">
          {formatWorkClock(currentSessionSeconds)}
        </span>
      </div>

      <div aria-hidden="true" className="my-1 h-px bg-line" />
    </>
  );
}

const ROLE_LABELS = { ADMIN: "Administrator", AGENT: "Agent" } as const;

/**
 * Admin is marked in the accent — the app's one signal colour. It is the rarer,
 * sharper state, and this is the one place in the shell where knowing which you
 * are matters.
 */
function RoleBadge({ role }: { role: SessionUser["role"] }) {
  return (
    <span
      className={`chip shrink-0 border text-[10px] uppercase tracking-wider ${
        role === "ADMIN"
          ? "border-accent-line bg-accent-soft text-accent"
          : "border-line-2 text-fg-3"
      }`}
    >
      {role}
    </span>
  );
}

/** Up to two initials — "John Smith" -> JS, "Priya" -> P. */
function Initials({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-md border border-line-2 bg-surface font-medium text-fg-2 ${
        size === "lg" ? "h-8 w-8 text-caption" : "h-6 w-6 text-meta"
      }`}
    >
      {initials}
    </span>
  );
}
