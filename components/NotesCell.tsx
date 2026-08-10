"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

/**
 * Inline notes editing. Collapsed it shows up to two truncated lines; clicking
 * expands a textarea in place. Blur or Ctrl/Cmd+Enter *stages* the text and
 * Escape abandons it — the row's Save button is what actually commits.
 *
 * The collapsed state is deliberately chrome-free — a note should look like
 * handwriting on the row, not another input box in a table full of them.
 */
export default function NotesCell({
  value,
  leadName,
  pending = false,
  onChange,
}: {
  value: string;
  leadName: string;
  pending?: boolean;
  onChange: (notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }, [editing]);

  function open() {
    setDraft(value);
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    if (draft !== value) onChange(draft);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(value);
              setEditing(false);
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          }}
          rows={4}
          placeholder="Call notes…"
          className="ui-field h-auto w-full resize-y p-2 leading-relaxed"
          // The focus ring comes from `.ui-field`; nothing to restate here.
          autoFocus
        />
        <span className="text-meta text-fg-3">
          Esc to discard · Ctrl+Enter to apply, then Save
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title={value || undefined}
      aria-label={`Edit notes for ${leadName}`}
      className={`block min-h-[30px] w-full rounded-md border px-2 py-1 text-left transition-colors ${
        pending
          ? "border-warning-line bg-warning-bg"
          : value
            ? // A written note keeps the chrome-free treatment: it should read
              // as handwriting on the row, not as another input box.
              "border-transparent hover:border-line-2 hover:bg-hover"
            : // An empty one does not. Left bare it was indistinguishable from
              // a blank cell, so nobody could tell it was a place to type. The
              // dashed outline and the plus say "this is a control" without
              // giving it the weight of a filled field.
              "border-dashed border-line-2 hover:border-fg-4 hover:bg-hover"
      }`}
    >
      {value ? (
        <span
          className={`line-clamp-2 text-ui ${pending ? "text-warning" : "text-fg-2"}`}
        >
          {value}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-ui text-fg-3">
          <Plus className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
          Add note
        </span>
      )}
    </button>
  );
}