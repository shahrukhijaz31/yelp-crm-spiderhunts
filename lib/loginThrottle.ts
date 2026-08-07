/**
 * A brake on password guessing.
 *
 * In-process and deliberately simple: a sliding window of failures per
 * identifier and per client IP, with a lockout once either passes its limit.
 * It is not a distributed rate limiter and does not pretend to be — the portal
 * runs one Node process per blue/green slot, so a determined attacker who
 * knows both ports could get two windows instead of one. What it does buy is
 * the thing that actually matters against credential stuffing: an online
 * guessing attack is reduced from thousands of attempts a minute to a handful,
 * on top of scrypt already costing ~100ms per attempt.
 *
 * Successful sign-ins clear the identifier's record, so a user who mistyped
 * their password four times is not punished after getting it right.
 */

interface Window {
  failures: number[];
  /** Epoch ms until which every attempt is refused outright. */
  lockedUntil: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/** Per account name — the thing an attacker is trying to break into. */
const MAX_PER_IDENTIFIER = 8;
/** Per source address — higher, because a whole office shares one NAT address. */
const MAX_PER_IP = 30;

/**
 * Module-level state survives between requests in the same process and is
 * dropped on restart, which is the correct lifetime for a lockout: a deploy
 * clearing it is not a security event, and nothing needs to be persisted.
 */
const windows = new Map<string, Window>();

/** Bound the map so a flood of made-up usernames cannot grow it forever. */
const MAX_TRACKED = 5_000;

function windowFor(key: string): Window {
  const existing = windows.get(key);
  if (existing) return existing;

  if (windows.size >= MAX_TRACKED) sweep(true);
  const fresh: Window = { failures: [], lockedUntil: 0 };
  windows.set(key, fresh);
  return fresh;
}

function sweep(force = false): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, window] of windows) {
    window.failures = window.failures.filter((at) => at > cutoff);
    if (window.failures.length === 0 && window.lockedUntil < Date.now()) {
      windows.delete(key);
    }
  }
  // Still full of live entries: this is a flood, so start over rather than
  // let the map grow without bound.
  if (force && windows.size >= MAX_TRACKED) windows.clear();
}

export interface ThrottleVerdict {
  allowed: boolean;
  /** Seconds until the next attempt is accepted. Sent as `Retry-After`. */
  retryAfterSeconds: number;
}

function check(key: string, limit: number): ThrottleVerdict {
  const window = windowFor(key);
  const now = Date.now();

  if (window.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((window.lockedUntil - now) / 1000) };
  }

  window.failures = window.failures.filter((at) => at > now - WINDOW_MS);
  if (window.failures.length >= limit) {
    window.lockedUntil = now + LOCKOUT_MS;
    window.failures = [];
    return { allowed: false, retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000) };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** Called before checking a password. */
export function checkLoginAllowed(identifier: string, ip: string): ThrottleVerdict {
  const byIdentifier = check(`id:${identifier.toLowerCase()}`, MAX_PER_IDENTIFIER);
  if (!byIdentifier.allowed) return byIdentifier;
  return check(`ip:${ip}`, MAX_PER_IP);
}

/** Called after a password check fails. */
export function recordLoginFailure(identifier: string, ip: string): void {
  const now = Date.now();
  windowFor(`id:${identifier.toLowerCase()}`).failures.push(now);
  windowFor(`ip:${ip}`).failures.push(now);
}

/** Called after a password check succeeds. */
export function clearLoginFailures(identifier: string): void {
  windows.delete(`id:${identifier.toLowerCase()}`);
}

/**
 * The client address, taken from `X-Forwarded-For` because every request
 * arrives through nginx on loopback — without this every user would share the
 * single IP bucket for 127.0.0.1.
 *
 * Only the *last* hop is trusted to be honest, and the header is only trusted
 * at all because nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for` and
 * the Node server binds to loopback (`HOSTNAME=127.0.0.1`), so nothing else can
 * reach it directly. A spoofed value costs an attacker a fresh IP bucket, never
 * a fresh identifier bucket — which is the one guarding a specific account.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return request.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}
