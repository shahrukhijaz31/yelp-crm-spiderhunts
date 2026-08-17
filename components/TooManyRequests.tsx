import Link from "next/link";

/**
 * What a screen shows when its rate limit has been reached.
 *
 * Used by Export Data, the one *page* behind `lib/rateLimit.ts` — the other
 * three limited things are API routes that answer 429 and are never looked at
 * by a human. A page cannot answer 429 usefully, so it says the same thing in
 * the portal's own materials and points back at somewhere that works.
 *
 * Unlike `<AccessDenied />` this is not a refusal about *who* the reader is,
 * and the copy is careful to say so: nothing is wrong with their account and
 * nothing has been lost, they simply asked for this screen faster than the
 * server is willing to rebuild it. Telling somebody "access denied" when they
 * only have to wait would send them to their administrator for nothing.
 */
export default function TooManyRequests() {
  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <div className="panel mx-auto flex max-w-md flex-col items-center gap-5 px-6 py-12 text-center">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-recessed text-fg-4"
        >
          <ClockIcon />
        </span>

        <div>
          <h1 className="page-title">One moment</h1>
          <p className="mt-3 page-intro">
            This screen has been reloaded a lot in a short time. Wait a minute
            and try again — nothing has been lost.
          </p>
        </div>

        <Link href="/" className="ui-btn ui-btn-primary">
          Back to the worklist
        </Link>
      </div>
    </main>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[18px] w-[18px]">
      <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 4.75V8l2.25 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
