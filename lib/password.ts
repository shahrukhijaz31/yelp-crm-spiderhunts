import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Password hashing, on `node:crypto` alone.
 *
 * scrypt rather than bcrypt/argon2 from npm: it is memory-hard, it ships in
 * Node, and adding a native dependency would mean `npm ci` on the VPS needs a
 * compiler for the one thing that must never fail to install. The parameters
 * below are Node's defaults raised to the current OWASP floor for scrypt
 * (N = 2^16, r = 8, p = 1), which costs ~64MB and ~100ms per verification —
 * slow enough to make offline cracking expensive, fast enough for a login.
 *
 * The cost parameters are stored *in* the hash, so raising them later does not
 * invalidate existing passwords: old hashes keep verifying with the parameters
 * they were written with, and are re-hashed on the owner's next sign-in.
 */

/**
 * `promisify` picks the three-argument overload of `scrypt` and drops the
 * options object, which is where the cost parameters live — so the promise is
 * built by hand instead.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const FORMAT = "scrypt";
const COST = 2 ** 16;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** scrypt with N = 65536 needs more than the 32MB Node allows by default. */
const MAX_MEMORY = 256 * 1024 * 1024;

/** `scrypt$65536$8$1$<salt-b64>$<key-b64>` — self-describing, one column. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_BYTES, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  });

  return [
    FORMAT,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification. Returns false — never throws — for a malformed
 * or unrecognised stored hash, so a corrupt row denies access rather than
 * crashing the login route into a 500 that leaks that the account exists.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== FORMAT) return false;

  const [, costRaw, blockRaw, parallelRaw, saltRaw, keyRaw] = parts;
  const N = Number(costRaw);
  const r = Number(blockRaw);
  const p = Number(parallelRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise ask for a work factor that hangs the process.
  if (N > 2 ** 20 || r > 32 || p > 16) return false;

  const salt = Buffer.from(saltRaw, "base64");
  const expected = Buffer.from(keyRaw, "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * The rules for a new password. Deliberately length-first and composition-free:
 * a 12-character passphrase beats "P@ssw0rd!" and does not push people towards
 * writing it on a sticky note.
 */
export const PASSWORD_MIN_LENGTH = 12;

export function describePasswordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > 200) {
    // scrypt happily hashes megabytes; nobody needs to, and it is free CPU for
    // anyone who wants to tie the server up.
    return "Password must be 200 characters or fewer.";
  }
  return null;
}
