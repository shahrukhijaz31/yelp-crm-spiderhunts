/**
 * What is on screen while a lead is being read.
 *
 * A dynamic route with no `loading` file makes the browser sit on the previous
 * screen until the server answers, which on a click from the worklist means a
 * blank new tab. The skeleton is worth its existence for that alone — and it is
 * the shape of the workspace rather than a spinner, so the page appears to be
 * arriving rather than to be missing.
 *
 * Deliberately dependency-free and animated in CSS (`skeleton`, in
 * `globals.css`), which stops under `prefers-reduced-motion` with everything
 * else decorative.
 */
export default function LoadingLead() {
  return (
    <main aria-busy="true" aria-label="Loading lead" className="flex w-full flex-1 flex-col">
      <div className="ws-topbar">
        <span className="skeleton h-4 w-16 rounded" />
        <span className="skeleton h-4 w-48 rounded" />
      </div>

      <div className="ws-identity">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-9 sm:px-6">
          <span className="skeleton block h-8 w-[min(24rem,70%)] rounded-lg" />
          <span className="skeleton mt-3 block h-4 w-[min(18rem,55%)] rounded" />
          <div className="mt-5 flex flex-wrap gap-2">
            <span className="skeleton h-10 w-40 rounded-md" />
            <span className="skeleton h-10 w-32 rounded-md" />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <div className="panel p-4">
            <span className="skeleton block h-3 w-24 rounded" />
            <span className="skeleton mt-3 block h-9 w-full max-w-sm rounded-md" />
            <span className="skeleton mt-6 block h-3 w-24 rounded" />
            <span className="skeleton mt-3 block h-20 w-full rounded-lg" />
            <span className="skeleton mt-6 block h-3 w-24 rounded" />
            <span className="skeleton mt-3 block h-28 w-full rounded-lg" />
          </div>
          <div>
            <span className="skeleton block h-3 w-20 rounded" />
            <span className="skeleton mt-3 block h-14 w-full rounded-lg" />
            <span className="skeleton mt-3 block h-14 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </main>
  );
}
