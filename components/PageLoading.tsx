import { Loader2 } from "lucide-react";

/**
 * What is on screen while a portal page is being read.
 *
 * Every screen in this app is dynamic — the proxy stamps `no-store`, the layout
 * calls `connection()` — so a navigation is always a round trip to Postgres,
 * and without a boundary the browser sits on the *previous* screen with nothing
 * moving until the server answers. On a slow query that is indistinguishable
 * from a click that did not register, and the reliable response to it is to
 * click again.
 *
 * A wheel rather than a skeleton, and deliberately so: the lead page's skeleton
 * (`app/(portal)/leads/[id]/loading.tsx`) can draw the shape of what is coming
 * because there is exactly one shape. These are whole screens of different
 * shapes, and a skeleton that guesses wrong reads as a layout that jumped.
 *
 * `loading-fade` holds it invisible for the first fraction of a second (see
 * globals.css). A wheel that flashes up and vanishes on a fast navigation is
 * noise, and it makes a quick screen feel slower than showing nothing at all
 * would; past that threshold the wait is real and the wheel should be there.
 *
 * The spin is *not* stopped under `prefers-reduced-motion`, unlike everything
 * decorative. This one carries information — that the app is still working —
 * and a frozen wheel says the opposite.
 */
export default function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <main
      aria-busy="true"
      className="flex w-full min-w-0 flex-1 items-center justify-center px-4 py-24 sm:px-6"
    >
      {/* `role="status"` with the label inside, so a screen reader hears
          "Loading meetings" rather than being told nothing is happening. */}
      <div role="status" className="loading-fade flex flex-col items-center gap-3">
        <Loader2
          className="h-6 w-6 animate-spin text-fg-4"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <p className="text-ui text-fg-3">{label}…</p>
      </div>
    </main>
  );
}
