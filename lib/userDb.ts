import type { Role, SessionUser } from "./access";
import { describePasswordProblem, hashPassword } from "./password";
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

  if (edits.password !== undefined) {
    const problem = describePasswordProblem(edits.password);
    if (problem) throw new UserInputError(problem);
    data.passwordHash = await hashPassword(edits.password);
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
export function editEndsAccess(edits: UserEdits): boolean {
  // A role change is included: an agent promoted to admin, or an admin demoted,
  // must not keep browsing on a session that was resolved under the old role.
  // Sessions carry no role, but signing them out makes the change unmissable
  // and removes any doubt about half-rendered pages from before the change.
  return edits.isActive === false || edits.role !== undefined || edits.password !== undefined;
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
