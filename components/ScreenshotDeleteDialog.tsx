"use client";

import { useEffect, useId, useRef } from "react";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";

/**
 * "Delete screenshot?" — the one step between a trash icon and bytes that are
 * gone.
 *
 * A modal rather than the inline two-step the Users screen uses, and the grid is
 * why: a confirmation tucked into a card would sit inside a gallery of forty
 * near-identical rectangles, where "which one is this about" is a real question.
 * A window over the grid answers it by being the only thing on screen, and it is
 * the same window for one screenshot and for ninety — the count is the only part
 * that changes, so there is no second dialog to keep in step with this one.
 *
 * Built from parts that already exist: the scrim, `panel-float`, the `h-9`
 * buttons and `ui-btn-danger` are `ResetPasswordDialog`'s, which is the other
 * place in this portal where a dialog stands in front of something irreversible.
 *
 * Nothing here is a permission. The delete it confirms is
 * `DELETE /api/admin/screenshots…`, which resolves the caller's role from
 * Postgres on every request and answers 403 to an agent; this component is
 * simply never rendered for one, because the page above it refuses first.
 */
export default function ScreenshotDeleteDialog({
  count,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** How many screenshots the confirmed action would delete. Always ≥ 1. */
  count: number;
  busy: boolean;
  /** A failed attempt, shown in place rather than closing the window. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const many = count > 1;

  /*
   * Escape cancels, and it is ignored while the request is in flight — closing
   * the window mid-delete would leave the administrator watching a grid that is
   * about to change for reasons nothing on screen explains.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!busy) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  /*
   * Focus lands on the destructive button, which is the deliberate choice: this
   * window is only ever opened by someone who has just clicked a trash icon, so
   * Enter completing what they started is what they expect. Escape and the
   * backdrop are both one keystroke or one click away, and the window itself is
   * the guard — not the position of the cursor inside it.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          if (!busy) onCancel();
        }}
        className="absolute inset-0 cursor-default bg-base/60 backdrop-blur-[3px]"
      />

      <div className="panel-float pop-in relative w-full max-w-[420px] p-5 [--pop-origin:center]">
        <header className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-danger-line bg-danger-bg text-danger">
            <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-cell font-medium tracking-[-0.015em] text-fg">
              {many ? `Delete ${count.toLocaleString()} screenshots?` : "Delete screenshot?"}
            </h2>
            <p id={bodyId} className="mt-1 text-caption leading-relaxed text-fg-3">
              {many
                ? "This will permanently delete the selected screenshots and cannot be undone."
                : "This screenshot will be permanently deleted and cannot be recovered."}
            </p>
          </div>
        </header>

        {error && (
          <p
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-caption leading-relaxed text-danger"
          >
            <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ui-btn ui-btn-ghost h-9"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            className="ui-btn ui-btn-danger h-9"
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            )}
            {busy ? "Deleting…" : many ? "Delete Screenshots" : "Delete Screenshot"}
          </button>
        </div>
      </div>
    </div>
  );
}
