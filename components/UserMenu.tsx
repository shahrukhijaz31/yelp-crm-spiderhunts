"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, LogOut } from "lucide-react";

import { LOGIN_PATH, type SessionUser } from "@/lib/access";

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
 * library, because there is exactly one menu in this application and it has
 * one item. Down-arrow from the trigger opens it and lands on that item, Up
 * and Down wrap within the menu, Escape closes and returns focus to the
 * trigger, and Tab out closes it. That is the whole `menu` pattern for a menu
 * this size.
 */
export default function UserMenu({ user }: { user: SessionUser }) {
  const router = useRouter();
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
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

          <button
            ref={itemRef}
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
