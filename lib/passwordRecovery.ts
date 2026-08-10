import { PASSWORD_MIN_LENGTH } from "./password";

/**
 * The browser's half of password management.
 *
 * The mirror of `lib/auth.ts`: thin wrappers over the endpoints, plus the
 * vocabulary the forms speak. Nothing here decides anything — every rule in
 * this file is also enforced server-side, and the server's answer is the one
 * that counts. What it buys is the difference between a form that tells you
 * your passwords do not match as you type and one that tells you after a round
 * trip.
 *
 * Deliberately free of `node:crypto` and Prisma so it can be pulled into a
 * client component; the code generation and verification it talks to live in
 * `lib/passwordReset.ts`, which can never be.
 */

export const RESET_CODE_PLACEHOLDER = "SH-7K4P-92XM";

/**
 * Format a code as it is typed: upper-cased, dashes inserted, junk dropped.
 *
 * People are given these verbally and paste them from chat messages, so the
 * field accepts `sh7k4p92xm`, `SH 7K4P 92XM` and the canonical spelling
 * identically. The server normalises again on arrival — this is convenience,
 * and convenience is not validation.
 */
export function formatResetCodeInput(raw: string): string {
  const bare = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = (bare.startsWith("SH") ? bare.slice(2) : bare).slice(0, 8);

  const groups = [body.slice(0, 4), body.slice(4, 8)].filter(Boolean);
  return ["SH", ...groups].join("-");
}

/** What the person is agreeing to when they pick a new password. */
export interface PasswordCheck {
  label: string;
  met: boolean;
}

export function passwordChecks(password: string, confirmation: string): PasswordCheck[] {
  return [
    { label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: password.length >= PASSWORD_MIN_LENGTH },
    { label: "Both entries match", met: password.length > 0 && password === confirmation },
  ];
}

/**
 * A coarse strength read, shown as three segments.
 *
 * Length-weighted rather than composition-weighted, matching the server's rule
 * (`describePasswordProblem`): a long passphrase is stronger than a short one
 * with a punctuation mark in it, and a meter that says otherwise teaches the
 * wrong habit. Variety still counts for something — it is the difference
 * between "aaaaaaaaaaaaaaa" and a real phrase — just not for much.
 */
export type PasswordStrength = "weak" | "fair" | "strong";

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return "weak";

  const variety =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^\w\s]/.test(password)) +
    // A space is the signature of a passphrase, which is the shape worth
    // rewarding here.
    Number(/\s/.test(password));

  const distinct = new Set(password).size;

  if (password.length >= 16 && variety >= 2 && distinct >= 8) return "strong";
  if (variety >= 2 || password.length >= 16) return "fair";
  return "weak";
}

/**
 * A failure carries the server's sentence *and* its code. The sentence is what
 * the person reads; the code is what the form branches on — matching on the
 * wording would make the copy load-bearing, and the first person to soften a
 * message would silently change the flow.
 */
type Outcome<T> =
  | ({ ok: true } & T)
  | { ok: false; message: string; code: string };

const NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
const SERVER_MESSAGE = "Something went wrong on our end. Try again in a moment.";

/** One shape for every call here: the server's message, or a generic one. */
async function post<T>(url: string, body: unknown): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: NETWORK_MESSAGE, code: "network" };
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    // The API's validation messages are written for these forms and are shown
    // verbatim; only an unexpected failure falls back to something vague.
    return {
      ok: false,
      message: typeof payload.message === "string" ? payload.message : SERVER_MESSAGE,
      code: typeof payload.error === "string" ? payload.error : "server",
    };
  }

  return { ok: true, ...(payload as T) };
}

/** Profile → Change password. */
export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<Outcome<Record<string, never>>> {
  return post("/api/account/password", input);
}

/** Login → Forgot your password? → step one. */
export function verifyResetCode(input: {
  username: string;
  code: string;
}): Promise<Outcome<{ name?: string }>> {
  return post("/api/auth/reset/verify", input);
}

/** Login → Forgot your password? → step two. */
export function completePasswordReset(input: {
  username: string;
  code: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<Outcome<{ username?: string }>> {
  return post("/api/auth/reset/complete", input);
}

/** Admin → Users → Reset password. */
export function generateResetCode(
  userId: string,
): Promise<Outcome<{ code?: string; expiresAt?: string; expiresInMinutes?: number }>> {
  return post(`/api/users/${userId}/password-reset`, {});
}
