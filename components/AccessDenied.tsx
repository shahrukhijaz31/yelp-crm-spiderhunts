import Link from "next/link";

/**
 * What an agent sees at an admin URL.
 *
 * Not a redirect to /login — they are signed in, and bouncing them to a form
 * they already satisfied reads as "your session broke" and sends people to ask
 * IT why they were logged out. Not a redirect to the worklist either: silently
 * moving someone somewhere else leaves them wondering whether they mistyped.
 *
 * The copy names nothing. "Administrators only" and the page's own title would
 * both be more than someone probing URLs should learn about what is behind
 * this one.
 *
 * Same materials as the rest of the portal: surface card on base, `border-line`
 * hairline, Fraunces heading, the accent used once and only as an outline.
 */
export default function AccessDenied() {
  return (
    <main className="mx-auto w-full max-w-[1760px] flex-1 px-7 py-8">
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 rounded-2xl border border-line bg-surface px-6 py-10 text-center">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent"
        >
          <LockIcon />
        </span>

        <div>
          <h1 className="display-num text-[22px] leading-none text-fg">Access denied</h1>
          <p className="mt-3 text-[13px] leading-relaxed text-fg-3">
            You don&apos;t have permission to access this page. If you think you
            should, ask your workspace administrator.
          </p>
        </div>

        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Back to the worklist
        </Link>
      </div>
    </main>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[18px] w-[18px]">
      <rect
        x="3.25"
        y="7"
        width="9.5"
        height="6.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
