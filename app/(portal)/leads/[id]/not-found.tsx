import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";

/**
 * The lead in this tab does not exist.
 *
 * Reachable two ways, and the copy has to cover both: a mistyped or stale URL,
 * and a lead that was in the list when the tab was opened and has since been
 * removed from the table. Neither is an error the agent caused, so this is a
 * dead end with a way out rather than a failure message.
 */
export default function LeadNotFound() {
  return (
    <main className="flex w-full flex-1 items-center justify-center px-4 py-16">
      <div className="panel max-w-md px-6 py-10 text-center">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-recessed text-fg-4"
        >
          <SearchX className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <h1 className="text-cell font-medium text-fg">No lead here</h1>
        <p className="mx-auto mt-2 max-w-[42ch] text-ui leading-relaxed text-fg-3">
          This lead is not in the workspace. It may have been removed since the
          link was opened, or the address may be incomplete.
        </p>
        <Link href="/" className="ui-btn ui-btn-secondary mx-auto mt-5 h-9">
          <ArrowLeft className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          Back to leads
        </Link>
      </div>
    </main>
  );
}
