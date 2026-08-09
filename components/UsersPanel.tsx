"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Role } from "@/lib/access";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

/**
 * Who can sign in, and as what.
 *
 * Built from the portal's existing parts: the hairline-separated card list
 * from Settings, the h-9 controls and accent button from the Import view, the
 * mono status chips from the worklist. No new visual language — this is
 * another administrator screen, not a console.
 *
 * Every action here is a request to `/api/users`, which re-checks that the
 * caller is an administrator against the session in Postgres. Nothing in this
 * component is a permission check; the disabled buttons and hidden controls
 * are courtesy.
 */

export interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

type Notice = { tone: "ok" | "error"; message: string } | null;

export default function UsersPanel({
  users,
  currentUserId,
}: {
  users: UserRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);

  async function patchUser(id: string, edits: Record<string, unknown>, describe: string) {
    setBusyId(id);
    setNotice(null);
    try {
      const response = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edits),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNotice({ tone: "error", message: payload.message ?? "That change was refused." });
        return;
      }

      setNotice({ tone: "ok", message: describe });
      // The list is server-rendered, so a refresh is what makes the change
      // visible — and it re-reads it as the current user, which keeps the
      // screen honest if the caller's own access has changed underneath them.
      router.refresh();
    } catch {
      setNotice({ tone: "error", message: "Could not reach the server. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="page-title">Users</h1>
        <p className="mt-3 page-intro">
          Everyone who can sign in to this workspace. Agents get the worklist
          and meetings; administrators get everything, including this page.
          Disabling an account ends its sessions immediately.
        </p>
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

      {/* One panel with hairline-separated rows, rather than a stack of cards:
          a user list is a table of people, and eight separate cards would give
          each of them a weight none of them has. */}
      <ul className="panel flex flex-col gap-px overflow-hidden bg-line">
        {users.map((user) => {
          const isSelf = user.id === currentUserId;
          const busy = busyId === user.id;

          return (
            <li
              key={user.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-surface px-5 py-3.5 transition-colors hover:bg-hover"
            >
              <div className="min-w-[190px] flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-cell font-semibold text-fg">{user.name}</h2>
                  {isSelf && (
                    <span className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-3">
                      You
                    </span>
                  )}
                  {!user.isActive && (
                    <span className="rounded border border-line-2 bg-st-steel-bg px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-st-steel">
                      Disabled
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-ui text-fg-2">{user.email}</p>
                <p className="mt-1 font-mono text-meta text-fg-3">
                  {user.username} · {describeLastLogin(user.lastLoginAt)}
                </p>
              </div>

              {/* Role. Disabled for your own row — the API refuses a self-edit
                  anyway, so a live control here would only offer a mistake. */}
              <label className="flex items-center gap-2">
                <span className="sr-only">Role for {user.name}</span>
                <select
                  value={user.role}
                  disabled={isSelf || busy}
                  onChange={(event) =>
                    void patchUser(
                      user.id,
                      { role: event.target.value },
                      `${user.name} is now ${event.target.value === "ADMIN" ? "an administrator" : "an agent"}. They have been signed out.`,
                    )
                  }
                  className="ui-field cursor-pointer"
                >
                  <option value="ADMIN">Admin</option>
                  <option value="AGENT">Agent</option>
                </select>
              </label>

              <button
                type="button"
                disabled={isSelf || busy}
                onClick={() =>
                  void patchUser(
                    user.id,
                    { isActive: !user.isActive },
                    user.isActive
                      ? `${user.name} has been disabled and signed out.`
                      : `${user.name} can sign in again.`,
                  )
                }
                className="ui-btn ui-btn-secondary"
              >
                {user.isActive ? "Disable" : "Enable"}
              </button>

              {/* Allowed on your own row, unlike role and disable: setting your
                  own password is not a way to lock yourself out. */}
              <button
                type="button"
                disabled={busy}
                onClick={() => setResettingId(resettingId === user.id ? null : user.id)}
                aria-expanded={resettingId === user.id}
                className="ui-btn ui-btn-secondary"
              >
                Password
              </button>

              {resettingId === user.id && (
                <form
                  className="flex w-full items-end gap-2 border-t border-line pt-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = new FormData(event.currentTarget).get("password");
                    void patchUser(
                      user.id,
                      { password: String(value ?? "") },
                      // Their sessions end with the change, so whoever is using
                      // the old password is signed out rather than left on a
                      // page that will start refusing them.
                      `${user.name}'s password has been changed. They have been signed out.`,
                    ).then(() => setResettingId(null));
                  }}
                >
                  <label className="flex flex-1 flex-col gap-1.5">
                    <span className="field-label">
                      New password for {user.name} ({PASSWORD_MIN_LENGTH}+ characters)
                    </span>
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      className="ui-field"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="ui-btn ui-btn-primary"
                  >
                    Set
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      <section className="panel px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-cell font-semibold text-fg">Add a user</h2>
            <p className="mt-1.5 text-ui text-fg-3">
              They sign in with the username or the email address, and the
              password you set here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating((open) => !open)}
            aria-expanded={creating}
            className="ui-btn ui-btn-secondary shrink-0"
          >
            {creating ? "Cancel" : "New user"}
          </button>
        </div>

        {creating && (
          <NewUserForm
            onDone={(message) => {
              setCreating(false);
              setNotice({ tone: "ok", message });
              router.refresh();
            }}
            onError={(message) => setNotice({ tone: "error", message })}
          />
        )}
      </section>
    </div>
  );
}

function NewUserForm({
  onDone,
  onError,
}: {
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          username: form.get("username"),
          email: form.get("email"),
          password: form.get("password"),
          role: form.get("role"),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The API's validation messages are written for this form, so they are
        // shown as-is rather than replaced with something vaguer.
        onError(payload.message ?? "Could not create that user.");
        return;
      }

      onDone(`${payload.user.name} can now sign in.`);
    } catch {
      onError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" name="name" autoComplete="name" required />
        <Field label="Username" name="username" autoComplete="off" required />
        <Field label="Email" name="email" type="email" autoComplete="off" required />
        <label className="flex flex-col gap-1.5">
          <span className="field-label">Role</span>
          <select
            name="role"
            defaultValue="AGENT"
            className="ui-field cursor-pointer"
          >
            <option value="AGENT">Agent</option>
            <option value="ADMIN">Admin</option>
          </select>
        </label>
      </div>

      <Field
        label={`Password (${PASSWORD_MIN_LENGTH}+ characters)`}
        name="password"
        type="password"
        autoComplete="new-password"
        required
      />

      <button
        type="submit"
        disabled={submitting}
        className="ui-btn ui-btn-primary mt-1 w-fit"
      >
        {submitting ? "Creating…" : "Create user"}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="field-label">{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        required={required}
        className="ui-field"
      />
    </label>
  );
}

/** `2026-08-07T…` -> `last signed in 7 Aug`, or `never signed in`. */
function describeLastLogin(iso: string | null): string {
  if (!iso) return "never signed in";
  const date = new Date(iso);
  return `last signed in ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}
