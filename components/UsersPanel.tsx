"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";

import ResetPasswordDialog from "./ResetPasswordDialog";
import type { Role } from "@/lib/access";
import { MODULE_LABELS, PORTAL_MODULES, type PortalModule } from "@/lib/modules";
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
  /** Set by a reset, cleared when the person redeems the code. */
  requirePasswordChange: boolean;
  /** Which workspaces this account may reach. Ignored for an administrator. */
  canAccessLeads: boolean;
  canAccessDemoWebsites: boolean;
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
  const [settingPasswordId, setSettingPasswordId] = useState<string | null>(null);
  /** The row whose reset dialog is open, if any. */
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  /**
   * The row whose delete confirmation is showing.
   *
   * Two steps rather than a `window.confirm`: the confirmation names the person
   * and says plainly that it cannot be undone, which a browser dialog cannot do
   * in the app's own voice. It is inline for the same reason "Set password" is —
   * the action belongs to one row, and a modal would hide the list it is about.
   */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

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

  /**
   * Remove an account for good.
   *
   * The server decides whether this is allowed, and it refuses far more often
   * than it agrees: an account that has logged any work is blocked with a 409
   * that explains what is in the way. That message is shown verbatim rather
   * than replaced with something generic — it is written for the person reading
   * it and already names the counts and the alternative.
   */
  async function removeUser(user: UserRow) {
    setBusyId(user.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNotice({
          tone: "error",
          message: payload.message ?? "That account could not be deleted.",
        });
        return;
      }

      setDeleteTarget(null);
      setNotice({ tone: "ok", message: `${user.name}'s account has been deleted.` });
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
          Everyone who can sign in to this workspace. Module access decides
          which of the two workspaces — Leads and Demo Websites — an agent is
          shown; administrators get everything, including this page. Disabling
          an account ends its sessions immediately.
        </p>
        {/* Said once, at the top, rather than repeated on every row: it is a
            property of the whole page. */}
        <p className="mt-2 page-intro text-fg-4">
          Passwords are never visible here or anywhere else — not to
          administrators, and not to us. Use{" "}
          <span className="text-fg-3">Reset password</span> to issue a one-time
          code the person exchanges for a password of their own.
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
                  {/* The state between a reset and the person redeeming it.
                      Worth a badge because it explains a support call before
                      it is made: this account cannot sign in, on purpose. */}
                  {user.requirePasswordChange && (
                    <span className="rounded border border-accent-line bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-accent">
                      Reset pending
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

              {/* Module access.
                  Two checkboxes rather than a multi-select, because the answer
                  is two independent yes/nos and a list box would make them look
                  like alternatives. Beside the role control because they are the
                  same kind of decision — what this person may do — and one row
                  down from it in reading order because the role is the coarser
                  of the two.

                  Ticked and disabled for an administrator: they have both
                  modules whatever their row says (`ADMIN_MODULE_ACCESS`), and a
                  live checkbox that changes nothing is worse than a fixed one
                  that explains itself in its title.

                  Disabled on your own row for any role. The API refuses a
                  self-edit of these anyway — there is deliberately no way for an
                  account to grant itself a module — so a live control here would
                  only offer a mistake. */}
              <ModuleAccess
                user={user}
                disabled={busy}
                isSelf={isSelf}
                onToggle={(module, next) =>
                  void patchUser(
                    user.id,
                    module === "leads"
                      ? { canAccessLeads: next }
                      : { canAccessDemoWebsites: next },
                    next
                      ? `${user.name} can now open ${MODULE_LABELS[module]}.`
                      : `${user.name} can no longer open ${MODULE_LABELS[module]}.`,
                  )
                }
              />

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

              {/* The recovery path: no password is chosen here, and none is
                  shown. It is refused on your own row — an administrator who
                  reset themselves would be signed out mid-action, holding a
                  code on a screen they are about to lose. Changing your own
                  password lives in the profile menu, where it belongs. */}
              <button
                type="button"
                disabled={isSelf || busy}
                onClick={() => setResetTarget(user)}
                title={
                  isSelf
                    ? "Use Change password in your profile menu"
                    : `Issue a one-time reset code for ${user.name}`
                }
                className="ui-btn ui-btn-secondary"
              >
                <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Reset password
              </button>

              {/* Allowed on your own row, unlike role and disable: setting your
                  own password is not a way to lock yourself out. */}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setSettingPasswordId(settingPasswordId === user.id ? null : user.id)
                }
                aria-expanded={settingPasswordId === user.id}
                className="ui-btn ui-btn-ghost"
              >
                Set password
              </button>

              {settingPasswordId === user.id && (
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
                    ).then(() => setSettingPasswordId(null));
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

              {/* Delete. Last in the row and the only ghost-to-danger control
                  on the screen, because it is the one action here with no way
                  back — every other one can be undone by doing it again.
                  Refused on your own row before the request is even made; the
                  API refuses it again for anyone who asks another way. */}
              <button
                type="button"
                disabled={isSelf || busy}
                onClick={() => setDeleteTarget(deleteTarget === user.id ? null : user.id)}
                aria-expanded={deleteTarget === user.id}
                title={
                  isSelf
                    ? "You cannot delete your own account"
                    : `Delete ${user.name}'s account permanently`
                }
                className="ui-btn ui-btn-ghost ml-auto text-fg-3 hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Delete
              </button>

              {deleteTarget === user.id && (
                <div className="flex w-full flex-wrap items-center gap-3 border-t border-line pt-3">
                  <p className="min-w-0 flex-1 text-caption text-fg-2">
                    Delete <span className="font-medium text-fg">{user.name}</span>{" "}
                    permanently? This cannot be undone.{" "}
                    <span className="text-fg-4">
                      An account that has logged any work will be refused — disable
                      it instead, which ends access and keeps the record.
                    </span>
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeUser(user)}
                    className="ui-btn ui-btn-danger"
                  >
                    {busy ? "Deleting…" : "Delete permanently"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteTarget(null)}
                    className="ui-btn ui-btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
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

      {resetTarget && (
        <ResetPasswordDialog
          user={resetTarget}
          onIssued={() => {
            // Refresh while the code is still on screen, so the row behind the
            // dialog already shows "Reset pending" when it closes. The dialog
            // holds the code in its own state and is unaffected by the
            // re-render.
            router.refresh();
            setNotice({
              tone: "ok",
              message: `A reset code was generated for ${resetTarget.name}. Their password no longer works and they have been signed out.`,
            });
          }}
          onClose={() => setResetTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * One account's two module switches.
 *
 * Nothing here is a permission. Every tick is a `PATCH /api/users/:id` behind
 * `apiAdmin()`, which re-reads the caller's role from Postgres and refuses a
 * self-edit of these two fields; and every module gate in the portal resolves
 * the flags from the `users` row on the request that needs them, so unticking a
 * box takes effect on that agent's very next click without anybody being signed
 * out.
 */
function ModuleAccess({
  user,
  disabled,
  isSelf,
  onToggle,
}: {
  user: UserRow;
  disabled: boolean;
  isSelf: boolean;
  onToggle: (module: PortalModule, next: boolean) => void;
}) {
  const isAdmin = user.role === "ADMIN";

  return (
    <fieldset className="flex min-w-[13rem] flex-col gap-1">
      <legend className="field-label">Module access</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {PORTAL_MODULES.map((module) => {
          const granted = isAdmin
            ? true
            : module === "leads"
              ? user.canAccessLeads
              : user.canAccessDemoWebsites;

          return (
            <label
              key={module}
              title={
                isAdmin
                  ? "Administrators always have every module"
                  : isSelf
                    ? "You cannot change your own module access"
                    : `${granted ? "Remove" : "Grant"} ${MODULE_LABELS[module]} for ${user.name}`
              }
              className={`flex items-center gap-1.5 text-caption ${
                isAdmin || isSelf ? "text-fg-4" : "cursor-pointer text-fg-2"
              }`}
            >
              <input
                type="checkbox"
                checked={granted}
                disabled={isAdmin || isSelf || disabled}
                onChange={(event) => onToggle(module, event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--c-accent)]"
              />
              {MODULE_LABELS[module]}
            </label>
          );
        })}
      </div>
    </fieldset>
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
          canAccessLeads: form.get("leads") === "on",
          canAccessDemoWebsites: form.get("demoWebsites") === "on",
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

      {/* The same two switches the rows carry, with the same defaults the
          database uses for an account nobody mentions: the worklist on, Demo
          Websites off. Written out here rather than left to the column default
          so the administrator creating the account can see what they are
          agreeing to, and change it before the person first signs in. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="field-label">Module access</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {PORTAL_MODULES.map((module) => (
            <label key={module} className="flex items-center gap-2 text-ui text-fg-2">
              <input
                type="checkbox"
                name={module}
                defaultChecked={module === "leads"}
                className="h-3.5 w-3.5 accent-[var(--c-accent)]"
              />
              {MODULE_LABELS[module]}
            </label>
          ))}
        </div>
        <p className="text-meta text-fg-4">
          Ignored for an administrator, who always has both.
        </p>
      </fieldset>

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
