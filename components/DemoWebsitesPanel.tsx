"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, ImageOff, Pencil, Plus, Search, Trash2 } from "lucide-react";

import DemoWebsiteDialog, { OpenDemoButton, StatusChip } from "./DemoWebsiteDialog";
import DemoWebsiteForm from "./DemoWebsiteForm";
import { demoImageSrc } from "./demoImage";
import Pagination from "./Pagination";
import {
  buildDemoWebsiteParams,
  DEMO_PAGE_SIZES,
  DEMO_WEBSITE_STATUSES,
  DEMO_WEBSITE_STATUS_LABELS,
  demoUrlHost,
  formatDemoDay,
  type DemoPageSize,
  type DemoSortKey,
  type DemoWebsiteCard,
  type DemoWebsitePayload,
  type DemoWebsiteQuery,
  type DemoWebsiteStatus,
} from "@/lib/demoWebsiteRules";

/**
 * The Demo Websites workspace.
 *
 * ---------------------------------------------------------------------------
 * A first-class module, not a modified worklist
 * ---------------------------------------------------------------------------
 * It borrows the portal's parts — the `panel` surface, the `ui-field` and
 * `ui-btn` chassis, the shared `Pagination` the worklist and the screenshot
 * viewer already use — and none of its behaviour. There is no queue, no
 * callback urgency, no status wheel and, deliberately, **no audio anything**:
 * no upload control, no recording player, no delete-recording button, and
 * nothing in this file or the routes behind it that touches
 * `meeting_recordings`. What a lead does with a call recording, a demo website
 * does with a link and an image.
 *
 * ---------------------------------------------------------------------------
 * The server does the narrowing
 * ---------------------------------------------------------------------------
 * The search, the status filter, the sort, the page and the page size all
 * travel as query parameters (`lib/demoWebsiteRules.ts` holds the vocabulary
 * and validates it), and Postgres answers with at most one page. The browser
 * never holds the table — the same lesson the worklist learned, applied from
 * the start rather than after the payload got embarrassing.
 *
 * The first page is rendered on the server and handed in as `initialPayload`,
 * so the screen paints with real rows instead of a skeleton; this component
 * recognises the query it was handed and does not re-request it.
 *
 * ---------------------------------------------------------------------------
 * `canManage` is not a permission
 * ---------------------------------------------------------------------------
 * It decides whether Add, Edit and Delete are *drawn*. Every one of those
 * actions is a request to an endpoint behind `apiAdmin()`, which re-reads the
 * caller's role from the session row in Postgres — an agent who reconstructs
 * the request by hand gets a 403 whatever this prop says. The prop exists so an
 * agent is not shown controls that would refuse them, which is courtesy.
 */
export default function DemoWebsitesPanel({
  initialPayload,
  initialQuery,
  canManage,
}: {
  initialPayload: DemoWebsitePayload;
  initialQuery: DemoWebsiteQuery;
  canManage: boolean;
}) {
  const [query, setQuery] = useState<DemoWebsiteQuery>(initialQuery);
  const [payload, setPayload] = useState<DemoWebsitePayload>(initialPayload);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; message: string } | null>(null);

  /** What the search box holds. Debounced into `query.search`. */
  const [searchText, setSearchText] = useState(initialQuery.search);

  const [viewing, setViewing] = useState<DemoWebsiteCard | null>(null);
  /** `null` means "create"; a card means "edit". `false` means the form is shut. */
  const [editing, setEditing] = useState<DemoWebsiteCard | null | false>(false);
  const [deleteTarget, setDeleteTarget] = useState<DemoWebsiteCard | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * The query string the current payload answers.
   *
   * Held as a string so the effect below can compare cheaply and skip the fetch
   * for the page the server already rendered — the same trick the worklist
   * uses, and what stops the screen from re-requesting its own first paint.
   */
  const rendered = useRef(buildDemoWebsiteParams(initialQuery).toString());

  // The search box is typed into; the server is not. 300ms, matching the
  // worklist, so a five-letter search is one request rather than five.
  useEffect(() => {
    if (searchText === query.search) return;
    const timer = setTimeout(() => {
      setQuery((current) => ({ ...current, search: searchText, page: 1 }));
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, query.search]);

  useEffect(() => {
    const params = buildDemoWebsiteParams(query);
    const key = params.toString();
    if (key === rendered.current) return;

    const controller = new AbortController();
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/demo-websites?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? "Demo websites could not be loaded.");
          return;
        }

        const next = (await response.json()) as DemoWebsitePayload;
        rendered.current = key;
        setPayload(next);
      } catch (problem) {
        if ((problem as Error).name === "AbortError") return;
        setError("Could not reach the server. Try again.");
      } finally {
        setBusy(false);
      }
    })();

    return () => controller.abort();
  }, [query]);

  /**
   * Re-read the current page after a write.
   *
   * A create, an edit or a delete changes the counts and can change which rows
   * are on this page, so the honest thing is to ask again rather than to patch
   * the array in place and hope the filter still agrees. Forcing the key to a
   * value the effect cannot match is what makes the same query re-run.
   */
  const refresh = useCallback(() => {
    rendered.current = "";
    setQuery((current) => ({ ...current }));
  }, []);

  async function removeDemoWebsite(target: DemoWebsiteCard) {
    setDeleting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/demo-websites/${target.id}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        imageOrphaned?: boolean;
      };

      if (!response.ok) {
        setNotice({ tone: "error", message: body.message ?? "That could not be deleted." });
        return;
      }

      setDeleteTarget(null);
      // The server says so when the row went but its image file did not, and
      // that sentence is shown rather than replaced with an unqualified
      // success — a delete that half worked should not read as a clean one.
      setNotice({
        tone: body.imageOrphaned ? "error" : "ok",
        message: body.message ?? `${target.name} has been deleted.`,
      });
      if (viewing?.id === target.id) setViewing(null);
      refresh();
    } catch {
      setNotice({ tone: "error", message: "Could not reach the server. Try again." });
    } finally {
      setDeleting(false);
    }
  }

  const { demoWebsites, meta, statusCounts } = payload;
  const totalAll = DEMO_WEBSITE_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0);

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        {/* --- header ---------------------------------------------------- */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="page-title">Demo Websites</h1>
            <p className="mt-3 page-intro">
              Websites built to show clients. Open one in a new tab to present
              it, or view the record for the image, the contact details and the
              notes.
              {!canManage && " This list is read-only for your account."}
            </p>
          </div>

          {canManage && (
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="ui-btn ui-btn-primary shrink-0"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Add Demo Website
            </button>
          )}
        </header>

        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`rounded-lg border px-4 py-3 text-ui ${
              notice.tone === "ok"
                ? "border-success-line bg-success-bg text-success"
                : "border-danger-line bg-danger-bg text-danger"
            }`}
          >
            {notice.message}
          </p>
        )}

        {/* --- toolbar --------------------------------------------------- */}
        <div className="panel flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search demo websites</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-4"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search name, client, link, phone or email"
              autoCapitalize="none"
              spellCheck={false}
              className="ui-field w-full pl-8"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <StatusFilter
              value={query.status}
              counts={statusCounts}
              total={totalAll}
              onChange={(status) => setQuery((current) => ({ ...current, status, page: 1 }))}
            />

            <label className="flex items-center gap-2">
              <span className="sr-only">Sort by</span>
              <select
                value={`${query.sort.key}:${query.sort.direction}`}
                onChange={(event) => {
                  const [key, direction] = event.target.value.split(":");
                  setQuery((current) => ({
                    ...current,
                    sort: {
                      key: key as DemoSortKey,
                      direction: direction as "asc" | "desc",
                    },
                    page: 1,
                  }));
                }}
                className="ui-field w-[11.5rem] cursor-pointer"
              >
                <option value="created:desc">Newest first</option>
                <option value="created:asc">Oldest first</option>
                <option value="updated:desc">Recently updated</option>
                <option value="name:asc">Name A–Z</option>
                <option value="name:desc">Name Z–A</option>
                <option value="client:asc">Client A–Z</option>
                <option value="status:asc">Status</option>
              </select>
            </label>
          </div>
        </div>

        {/* --- the list -------------------------------------------------- */}
        <section className="panel overflow-hidden" aria-busy={busy}>
          {error ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
              <p className="text-ui text-danger">{error}</p>
              <button type="button" onClick={refresh} className="ui-btn ui-btn-secondary">
                Try again
              </button>
            </div>
          ) : demoWebsites.length === 0 ? (
            <EmptyState
              filtered={query.search.trim() !== "" || query.status !== null}
              canManage={canManage}
              onClear={() =>
                setQuery((current) => ({ ...current, search: "", status: null, page: 1 }))
              }
              onAdd={() => setEditing(null)}
              onClearSearchText={() => setSearchText("")}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[62rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    <Th className="w-[4.5rem]">
                      <span className="sr-only">Image</span>
                    </Th>
                    <Th>Demo website</Th>
                    <Th>Client</Th>
                    <Th>Demo link</Th>
                    <Th className="w-[7rem]">Status</Th>
                    <Th className="w-[7rem]">Created</Th>
                    <Th className="w-[7rem]">Updated</Th>
                    <Th className="w-[1%] text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody className={busy ? "loading-fade" : undefined}>
                  {demoWebsites.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-line last:border-0 transition-colors hover:bg-hover"
                    >
                      <Td>
                        <Thumbnail demoWebsite={row} onOpen={() => setViewing(row)} />
                      </Td>

                      <Td>
                        <button
                          type="button"
                          onClick={() => setViewing(row)}
                          className="max-w-[18rem] truncate text-left text-cell font-medium text-fg hover:text-accent hover:underline"
                          title={row.name}
                        >
                          {row.name}
                        </button>
                        {(row.phone || row.email) && (
                          <p className="mt-0.5 truncate font-mono text-meta text-fg-4">
                            {[row.phone, row.email].filter(Boolean).join(" · ")}
                          </p>
                        )}
                      </Td>

                      <Td>
                        <span className="block max-w-[12rem] truncate text-ui text-fg-2">
                          {row.clientName || <span className="text-fg-4">—</span>}
                        </span>
                      </Td>

                      <Td>
                        {/* The host rather than the whole URL: a table cell has
                            no room for a path, and the full link is one click
                            away in the detail window. */}
                        <a
                          href={row.demoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={row.demoUrl}
                          className="block max-w-[13rem] truncate font-mono text-caption text-fg-2 hover:text-accent hover:underline"
                        >
                          {demoUrlHost(row.demoUrl)}
                        </a>
                      </Td>

                      <Td>
                        <StatusChip status={row.status} />
                      </Td>

                      <Td>
                        <span className="tnum whitespace-nowrap font-mono text-meta text-fg-3">
                          {formatDemoDay(row.createdAt)}
                        </span>
                      </Td>

                      <Td>
                        <span className="tnum whitespace-nowrap font-mono text-meta text-fg-3">
                          {formatDemoDay(row.updatedAt)}
                        </span>
                      </Td>

                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <OpenDemoButton url={row.demoUrl} className="h-7 px-2 text-caption" />
                          <button
                            type="button"
                            onClick={() => setViewing(row)}
                            title={`View ${row.name}`}
                            className="ui-btn ui-btn-secondary h-7 px-2 text-caption"
                          >
                            <Eye className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                            View
                          </button>
                          {canManage && (
                            <>
                              <button
                                type="button"
                                onClick={() => setEditing(row)}
                                title={`Edit ${row.name}`}
                                className="ui-btn ui-btn-ghost h-7 w-7 !px-0"
                              >
                                <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                <span className="sr-only">Edit {row.name}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(row)}
                                title={`Delete ${row.name}`}
                                className="ui-btn ui-btn-ghost h-7 w-7 !px-0 text-fg-3 hover:text-danger"
                              >
                                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                <span className="sr-only">Delete {row.name}</span>
                              </button>
                            </>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {demoWebsites.length > 0 && (
            <Pagination<DemoPageSize>
              page={meta.page}
              pageSize={meta.pageSize}
              total={meta.total}
              totalPages={meta.totalPages}
              busy={busy}
              onPageChange={(page) => setQuery((current) => ({ ...current, page }))}
              onPageSizeChange={(pageSize) =>
                setQuery((current) => ({ ...current, pageSize, page: 1 }))
              }
              noun="demo websites"
              emptyLabel="No demo websites match the current filters"
              pageSizes={DEMO_PAGE_SIZES}
              label="Demo website pages"
            />
          )}
        </section>
      </div>

      {viewing && (
        <DemoWebsiteDialog demoWebsite={viewing} onClose={() => setViewing(null)} />
      )}

      {editing !== false && canManage && (
        <DemoWebsiteForm
          demoWebsite={editing}
          onClose={() => setEditing(false)}
          onSaved={(saved, message) => {
            if (message) {
              setEditing(false);
              setNotice({ tone: "ok", message });
            }
            // The open detail window, if it is this record, follows the save
            // rather than showing what was true before it.
            if (viewing?.id === saved.id) setViewing(saved);
            refresh();
          }}
        />
      )}

      {/* --- delete confirmation ----------------------------------------- */}
      {/* A dialog rather than `window.confirm`: it names the record, says what
          else goes with it, and speaks in the app's own voice. */}
      {deleteTarget && canManage && (
        <div className="lead-overlay" role="presentation">
          <button
            type="button"
            aria-label="Cancel"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
            className="lead-overlay-scrim"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={`Delete ${deleteTarget.name}`}
            className="panel pop-in relative z-10 mx-4 flex w-full max-w-md flex-col gap-4 px-6 py-5"
          >
            <div>
              <h2 className="text-cell font-semibold text-fg">
                Delete {deleteTarget.name}?
              </h2>
              <p className="mt-2 text-ui text-fg-2">
                This removes the record permanently
                {deleteTarget.image ? ", along with its demo image" : ""}. It cannot
                be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="ui-btn ui-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                aria-busy={deleting}
                onClick={() => void removeDemoWebsite(deleteTarget)}
                className="ui-btn ui-btn-danger"
              >
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * The row thumbnail.
 *
 * `loading="lazy"` so a page of a hundred rows costs only what is scrolled
 * past — the bytes are the full image at every size, because there is no
 * resizing pipeline in this application and inventing one for a 40px square
 * would be a larger feature than the module it serves. The route sends a
 * five-minute private cache, so scrolling back up is free.
 */
function Thumbnail({
  demoWebsite,
  onOpen,
}: {
  demoWebsite: DemoWebsiteCard;
  onOpen: () => void;
}) {
  if (!demoWebsite.image) {
    return (
      <span
        aria-hidden="true"
        className="flex h-10 w-14 items-center justify-center rounded border border-line bg-recessed text-fg-4"
      >
        <ImageOff className="h-3.5 w-3.5" strokeWidth={1.5} />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View ${demoWebsite.name}`}
      className="block h-10 w-14 overflow-hidden rounded border border-line bg-recessed outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={demoImageSrc(demoWebsite)}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    </button>
  );
}

function StatusFilter({
  value,
  counts,
  total,
  onChange,
}: {
  value: DemoWebsiteStatus | null;
  counts: Record<DemoWebsiteStatus, number>;
  total: number;
  onChange: (status: DemoWebsiteStatus | null) => void;
}) {
  const options: Array<{ key: DemoWebsiteStatus | null; label: string; count: number }> = [
    { key: null, label: "All", count: total },
    ...DEMO_WEBSITE_STATUSES.map((status) => ({
      key: status as DemoWebsiteStatus | null,
      label: DEMO_WEBSITE_STATUS_LABELS[status],
      count: counts[status],
    })),
  ];

  return (
    <div className="segmented" role="group" aria-label="Filter by status">
      {options.map((option) => (
        <button
          key={option.key ?? "all"}
          type="button"
          onClick={() => onChange(option.key)}
          data-active={value === option.key}
          aria-pressed={value === option.key}
          className="segment"
        >
          {option.label}
          <span className="segment-count">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  filtered,
  canManage,
  onClear,
  onClearSearchText,
  onAdd,
}: {
  filtered: boolean;
  canManage: boolean;
  onClear: () => void;
  onClearSearchText: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-recessed text-fg-4"
      >
        <ImageOff className="h-[18px] w-[18px]" strokeWidth={1.5} />
      </span>
      <div>
        <h2 className="text-cell font-semibold text-fg">
          {filtered ? "Nothing matches those filters" : "No demo websites yet"}
        </h2>
        <p className="mt-2 page-intro">
          {filtered
            ? "Try a different search, or clear the filters to see everything."
            : canManage
              ? "Add the first one — a name, the link and an image is enough to start."
              : "There is nothing here yet. An administrator adds demo websites."}
        </p>
      </div>
      {filtered ? (
        <button
          type="button"
          onClick={() => {
            onClearSearchText();
            onClear();
          }}
          className="ui-btn ui-btn-secondary"
        >
          Clear filters
        </button>
      ) : (
        canManage && (
          <button type="button" onClick={onAdd} className="ui-btn ui-btn-primary">
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Add Demo Website
          </button>
        )
      )}
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`col-head px-3 py-2.5 ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle ${className}`}>{children}</td>;
}
