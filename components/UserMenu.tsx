"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { LOGIN_PATH, type SessionUser } from "@/lib/access";

/**
 * The signed-in user, at the right-hand end of the nav bar.
 *
 * Built from the bar's own parts — the 8×8 bordered square of `ThemeToggle`,
 * the recessed pill of `QuickStats`, the same 13px/12.5px type ramp — so it
 * reads as another utility control rather than a component from somewhere
 * else. It sits last because it is the least-used thing up there.
 *
 * The user object is rendered by the server from the session row in Postgres
 * and passed down as a prop. Nothing here reads localStorage, and the role
 * shown is a label: no code anywhere decides what is permitted from this
 * value, so a user who edits it in devtools sees a different word and gains
 * exactly nothing.
 */
export default function UserMenu({ user }: { user: SessionUser }) {
  const router = useRouter();
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
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

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
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
    // authenticated shell — without it, going Back can paint the old nav bar
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
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        title={`${user.name} — ${ROLE_LABELS[user.role]}`}
        className={`flex h-9 items-center gap-2 rounded-lg border pl-1 pr-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
          open
            ? "border-line-2 bg-hover text-fg"
            : "border-line text-fg-2 hover:border-line-2 hover:bg-hover hover:text-fg"
        }`}
      >
        <Initials name={user.name} />
        <span className="hidden max-w-[130px] truncate text-ui font-medium lg:block">
          {user.name}
        </span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="panel-float absolute right-0 top-[calc(100%+8px)] z-40 w-60 overflow-hidden"
        >
          <div className="flex items-start gap-2.5 border-b border-line px-3 py-3">
            <Initials name={user.name} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-ui font-semibold leading-tight text-fg">
                {user.name}
              </p>
              <p className="mt-0.5 truncate text-caption leading-tight text-fg-3">
                {user.email}
              </p>
              <RoleBadge role={user.role} />
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 px-3 py-3 text-left text-ui font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            <SignOutIcon />
            {signingOut ? "Signing out…" : "Logout"}
          </button>
        </div>
      )}
    </div>
  );
}

const ROLE_LABELS = { ADMIN: "Administrator", AGENT: "Agent" } as const;

/**
 * Admin is marked in the accent red — the bar's one signal colour, already
 * spent on the active tab and overdue callbacks. It is the rarer, sharper
 * state, and this is the one place in the nav where knowing which you are
 * matters.
 */
function RoleBadge({ role }: { role: SessionUser["role"] }) {
  return (
    <span
      // 10.5px and fg-3, matching the "You"/"Disabled"/"Planned" tag chips on
      // the Users and Settings screens — one size for this kind of marker.
      className={`mt-2 inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider ${
        role === "ADMIN"
          ? "border-accent/50 bg-accent-soft text-accent"
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
      // A bordered tile with the raised fill, not a flat square of `rail`:
      // this is the one avatar in the app, and it should look like an object.
      className={`flex shrink-0 items-center justify-center rounded-md border border-line-2 bg-[image:var(--c-raise-fill)] font-semibold text-fg-2 shadow-e1 ${
        size === "lg" ? "h-9 w-9 text-ui" : "h-7 w-7 text-meta"
      }`}
    >
      {initials}
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path
        d="M2.5 4.5 6 8 9.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
      <path
        d="M6 2.5H3.5A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5H6M10 11l3-3-3-3M13 8H6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
