import type { Role, SessionUser } from "./access";
import { DEFAULT_MODULE_ACCESS, type ModuleAccess } from "./modules";
import { describePasswordProblem, hashPassword, verifyPassword } from "./password";
import { prisma } from "./prisma";

/**
 * Everything that reads or writes the `users` table.
 *
 * One rule runs through the file: `passwordHash` is selected only by the login
 * path, which needs it to verify a password and does nothing else with it.
 * Every other query uses `PUBLIC_FIELDS`, so no route can accidentally
 * serialise a hash into a response by returning "the user".
 */

const PUBLIC_FIELDS = {
  id: true,
  username: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  requirePasswordChange: true,
  // Which of the two workspaces the account may reach. Safe in a public
  // selection — they are a fact about somebody's access that an administrator
  // is looking at this list to see, and they are meaningless to anybody else
  // because nothing anywhere reads them from a response (see `lib/modules.ts`).
  canAccessLeads: true,
  canAccessDemoWebsites: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  /** True between an administrator issuing a reset code and it being redeemed. */
  requirePasswordChange: boolean;
  /**
   * Module access, as stored. For an administrator these are the columns and
   * not the answer — an administrator has both modules whatever the row says
   * (`ADMIN_MODULE_ACCESS`), and the user list draws their boxes ticked and
   * disabled to say so.
   */
  canAccessLeads: boolean;
  canAccessDemoWebsites: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export class UserInputError extends Error {}

export const ROLES: readonly Role[] = ["ADMIN", "AGENT"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Identifiers are stored and compared lower-cased, so `Admin` is `admin`. */
function normaliseIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The login lookup: username *or* email, either spelling, and the hash to
 * check against. The only function in the app that reads `passwordHash`.
 */
export async function findUserForLogin(identifier: string) {
  const id = normaliseIdentifier(identifier);
  if (!id) return null;

  return prisma.user.findFirst({
    where: { OR: [{ username: id }, { email: id }] },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      requirePasswordChange: true,
      passwordHash: true,
    },
  });
}

export async function markLoggedIn(userId: string): Promise<void> {
  await prisma.user
    .update({ where: { id: userId }, data: { lastLoginAt: new Date() } })
    .catch(() => {
      // Bookkeeping only. A failure here must not fail the sign-in.
    });
}

export async function listUsers(): Promise<PublicUser[]> {
  const rows = await prisma.user.findMany({
    select: PUBLIC_FIELDS,
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return rows as PublicUser[];
}

export async function countAdmins(): Promise<number> {
  return prisma.user.count({ where: { role: "ADMIN", isActive: true } });
}

export interface NewUser {
  name: string;
  username: string;
  email: string;
  password: string;
  role: Role;
  /**
   * Which workspaces the new account may reach. Optional, and the fallback is
   * `DEFAULT_MODULE_ACCESS` — the worklist on, Demo Websites off — so a caller
   * that has never heard of modules (the `scripts/create-user.ts` CLI, a future
   * seed) creates the account it always created.
   */
  modules?: Partial<ModuleAccess>;
}

/**
 * Validate and create. Throws `UserInputError` with a message written for the
 * admin filling in the form — the API route turns those into a 400 and shows
 * them verbatim, so they must never contain internals.
 */
export async function createUser(input: NewUser): Promise<PublicUser> {
  const name = input.name?.trim() ?? "";
  const username = normaliseIdentifier(input.username ?? "");
  const email = normaliseIdentifier(input.email ?? "");

  if (name.length < 2) throw new UserInputError("Enter the person's full name.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new UserInputError(
      "Username must be 3–32 characters: lower-case letters, numbers, dot, underscore or hyphen.",
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserInputError("Enter a valid email address.");
  }
  if (!isRole(input.role)) throw new UserInputError("Role must be ADMIN or AGENT.");

  const passwordProblem = describePasswordProblem(input.password ?? "");
  if (passwordProblem) throw new UserInputError(passwordProblem);

  const clash = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
    select: { username: true, email: true },
  });
  if (clash) {
    throw new UserInputError(
      clash.username === username
        ? "That username is already taken."
        : "That email address is already in use.",
    );
  }

  const created = await prisma.user.create({
    data: {
      name,
      username,
      email,
      role: input.role,
      passwordHash: await hashPassword(input.password),
      // Written for every role, including ADMIN, for the reason `updateUser`
      // gives: the columns should mean one thing whoever the row belongs to,
      // and an administrator's are simply never read.
      canAccessLeads: input.modules?.leads ?? DEFAULT_MODULE_ACCESS.leads,
      canAccessDemoWebsites:
        input.modules?.demoWebsites ?? DEFAULT_MODULE_ACCESS.demoWebsites,
    },
    select: PUBLIC_FIELDS,
  });

  return created as PublicUser;
}

export interface UserEdits {
  role?: Role;
  isActive?: boolean;
  name?: string;
  password?: string;
  /**
   * Module access. Settable only through `PATCH /api/users/:id`, which is
   * behind `apiAdmin()` and refuses a self-edit of these two — so there is no
   * path by which an account grants itself a module, at any privilege level.
   */
  canAccessLeads?: boolean;
  canAccessDemoWebsites?: boolean;
}

/**
 * Apply an admin's edits to another account.
 *
 * The last-admin guard lives here rather than in the route so it cannot be
 * bypassed by a second caller: demoting or disabling the only active
 * administrator would lock everyone out of user management permanently, with
 * no way back except a database console.
 *
 * Whether the caller is allowed to edit anyone at all is decided before this
 * is reached (`apiAdmin`), and *self*-edits are refused by the route: an admin
 * cannot demote or disable themselves either way.
 */
export async function updateUser(id: string, edits: UserEdits): Promise<PublicUser | null> {
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, isActive: true },
  });
  if (!target) return null;

  const data: {
    role?: Role;
    isActive?: boolean;
    name?: string;
    passwordHash?: string;
    requirePasswordChange?: boolean;
    canAccessLeads?: boolean;
    canAccessDemoWebsites?: boolean;
  } = {};

  if (edits.role !== undefined) {
    if (!isRole(edits.role)) throw new UserInputError("Role must be ADMIN or AGENT.");
    data.role = edits.role;
  }

  if (edits.isActive !== undefined) {
    if (typeof edits.isActive !== "boolean") {
      throw new UserInputError("`isActive` must be true or false.");
    }
    data.isActive = edits.isActive;
  }

  if (edits.name !== undefined) {
    const name = edits.name.trim();
    if (name.length < 2) throw new UserInputError("Enter the person's full name.");
    data.name = name;
  }

  /*
   * The two module switches.
   *
   * Written for any role, including an administrator, even though an
   * administrator's are never read. Refusing to store them would mean an
   * account demoted from ADMIN to AGENT arrived with whatever was in its row
   * from before it was promoted, which is a surprising thing for a demotion to
   * decide. Storing them keeps the columns meaning one thing.
   *
   * Nothing validates *which* modules are sensible: an agent with neither is a
   * legitimate state — a new starter an administrator has not finished setting
   * up — and it fails safe, because it grants nothing. The portal says so on
   * the account's first screen rather than pretending it is broken.
   */
  if (edits.canAccessLeads !== undefined) {
    if (typeof edits.canAccessLeads !== "boolean") {
      throw new UserInputError("`canAccessLeads` must be true or false.");
    }
    data.canAccessLeads = edits.canAccessLeads;
  }

  if (edits.canAccessDemoWebsites !== undefined) {
    if (typeof edits.canAccessDemoWebsites !== "boolean") {
      throw new UserInputError("`canAccessDemoWebsites` must be true or false.");
    }
    data.canAccessDemoWebsites = edits.canAccessDemoWebsites;
  }

  if (edits.password !== undefined) {
    const problem = describePasswordProblem(edits.password);
    if (problem) throw new UserInputError(problem);
    data.passwordHash = await hashPassword(edits.password);
    // An administrator handing over a password they chose settles the account:
    // the person can sign in with it, so leaving a "must change" flag standing
    // from an earlier reset would lock them out of a password that works.
    data.requirePasswordChange = false;
  }

  const losingAnAdmin =
    target.role === "ADMIN" &&
    target.isActive &&
    (data.role === "AGENT" || data.isActive === false);

  if (losingAnAdmin && (await countAdmins()) <= 1) {
    throw new UserInputError(
      "This is the only active administrator. Promote someone else first.",
    );
  }

  const updated = await prisma.user.update({
    where: { id },
    select: PUBLIC_FIELDS,
    data,
  });

  return updated as PublicUser;
}

/** Whether an edit ends the target's access and so should end their sessions. */
/*
 * Deliberately *not* included below: a module change.
 *
 * The two flags are re-read from Postgres on every request that consults them
 * (`lib/moduleAccess.ts`), so removing a module takes effect on that agent's
 * very next click — there is no cached grant for a sign-out to clear. Ending
 * their session would only throw away work in progress to achieve something
 * that has already happened, and an agent whose Demo Websites access was
 * removed while they were working a lead has no reason to be logged out of the
 * worklist.
 */
export function editEndsAccess(edits: UserEdits): boolean {
  // A role change is included: an agent promoted to admin, or an admin demoted,
  // must not keep browsing on a session that was resolved under the old role.
  // Sessions carry no role, but signing them out makes the change unmissable
  // and removes any doubt about half-rendered pages from before the change.
  return edits.isActive === false || edits.role !== undefined || edits.password !== undefined;
}

/**
 * Why a particular account cannot be deleted, with the numbers behind it.
 *
 * A distinct class from `UserInputError` because it is not bad input — the
 * request was well formed and the caller was entitled to make it. The route
 * turns this into a 409, and the message is written for the administrator
 * reading it, so it says what is in the way and what to do instead.
 */
export class UserDeleteBlocked extends Error {
  constructor(
    message: string,
    readonly footprint: UserFootprint,
  ) {
    super(message);
  }
}

/**
 * What an account has left behind that outlives it.
 *
 * These are exactly the three relations declared `onDelete: Restrict` in
 * schema.prisma. Counting them here rather than letting Postgres raise a
 * foreign-key violation is the difference between "this account has logged
 * 1,412 calls" and "update or delete on table users violates foreign key
 * constraint lead_activities_user_id_fkey".
 *
 * Everything *not* listed is `Cascade` and goes quietly with the row: sessions,
 * work sessions, pending OTPs, monitor devices, and reset codes issued *for*
 * this person. None of those mean anything once the account is gone.
 */
export interface UserFootprint {
  /** Calls logged, callbacks set, meetings booked — the performance record. */
  activity: number;
  /** Call recordings they uploaded. The audio outlives the account. */
  recordings: number;
  /** Reset codes they issued for *other* people, as an administrator. */
  resetsIssued: number;
}

export async function describeUserFootprint(id: string): Promise<UserFootprint> {
  const [activity, recordings, resetsIssued] = await Promise.all([
    prisma.leadActivity.count({ where: { userId: id } }),
    prisma.meetingRecording.count({ where: { uploadedById: id } }),
    prisma.passwordReset.count({ where: { issuedById: id } }),
  ]);
  return { activity, recordings, resetsIssued };
}

/**
 * Delete an account outright.
 *
 * **This is deliberately narrow, and the narrowness is the feature.** The
 * schema's standing position is that accounts are *disabled*, not deleted —
 * `isActive` ends access instantly while the record of who did what to a lead
 * survives — and three foreign keys enforce it (`onDelete: Restrict` on lead
 * activity, recordings and issued resets). This function does not work around
 * that. It removes accounts that have no history to protect: the ones created
 * with a typo in the username, the duplicate, the person who never signed in.
 *
 * An account that *has* worked is refused, with the counts, and pointed at
 * Disable. That is not an artificial limit — deleting such a row would either
 * fail at the database or, if the constraints were loosened, silently destroy
 * the attribution behind every performance figure that account appears in. A
 * month of somebody's reported work would quietly change.
 *
 * Two more guards, in the order that costs least:
 *
 *   - the last active administrator cannot be removed, whoever asks, for the
 *     same reason `updateUser` will not demote them — there is no way back
 *     except a database console;
 *   - the caller cannot delete themselves. That is enforced by the route,
 *     which knows who is asking; this function takes an id and no identity.
 *
 * Returns false when the id names nobody, so a double-submitted delete reads
 * as "already gone" rather than as an error.
 */
export async function deleteUser(id: string): Promise<boolean> {
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, isActive: true },
  });
  if (!target) return false;

  if (target.role === "ADMIN" && target.isActive && (await countAdmins()) <= 1) {
    throw new UserInputError(
      "This is the only active administrator. Promote someone else first.",
    );
  }

  const footprint = await describeUserFootprint(id);
  const blocking = [
    footprint.activity > 0 && `${footprint.activity.toLocaleString()} logged ${footprint.activity === 1 ? "action" : "actions"} on leads`,
    footprint.recordings > 0 && `${footprint.recordings} call ${footprint.recordings === 1 ? "recording" : "recordings"}`,
    footprint.resetsIssued > 0 && `${footprint.resetsIssued} password ${footprint.resetsIssued === 1 ? "reset" : "resets"} issued for other people`,
  ].filter((entry): entry is string => typeof entry === "string");

  if (blocking.length > 0) {
    throw new UserDeleteBlocked(
      `${target.name} cannot be deleted: the account has ${humanList(blocking)}. ` +
        "Deleting it would take that history with it. Disable the account instead — " +
        "it ends access immediately and keeps the record intact.",
      footprint,
    );
  }

  // Everything still attached is `Cascade`: sessions, work sessions, pending
  // verification codes, monitor devices, and reset codes issued *for* them.
  await prisma.user.delete({ where: { id } });
  return true;
}

/** `["a", "b", "c"]` -> `a, b and c`. */
function humanList(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The reset dialog needs to name the person before it does anything to them. */
export async function findUserForReset(id: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
  return (user as PublicUser | null) ?? null;
}

/**
 * A user changing their own password.
 *
 * The current password is required and verified here, not merely collected by
 * the form: a live session is not proof that the person at the keyboard is the
 * account owner, and an unattended logged-in machine is exactly the situation
 * this check exists for. It is also what makes the operation safe to expose to
 * every role — there is nothing to escalate when the caller must already know
 * the secret they are replacing.
 *
 * Deliberately *not* reachable for anybody else's account. An administrator
 * wanting to help someone has one route (`lib/passwordReset.ts`), and it never
 * involves knowing or seeing a password.
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    // The second of the two places in the app that reads a hash, and like the
    // first it does one thing with it and returns nothing derived from it.
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new UserInputError("No such user.");

  if (!(await verifyPassword(currentPassword ?? "", user.passwordHash))) {
    throw new UserInputError("Your current password is not correct.");
  }

  const problem = describePasswordProblem(newPassword ?? "");
  if (problem) throw new UserInputError(problem);

  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw new UserInputError("Choose a password you have not used here before.");
  }

  await prisma.user.update({
    where: { id: userId },
    // Clearing the flag here too: choosing your own password is the thing the
    // "must change" state was waiting for, however you arrived at it.
    data: { passwordHash: await hashPassword(newPassword), requirePasswordChange: false },
  });
}

/** For the profile dropdown and anywhere else that needs the caller's own record. */
export function toSessionUser(user: PublicUser): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    role: user.role,
  };
}
