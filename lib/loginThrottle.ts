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

/* ========================================================================== *
 * Who is calling — the address, not the address the caller claims.
 * ========================================================================== */

/**
 * When no address can be established, every caller shares this one bucket.
 *
 * That is the safe direction to fail. A limiter that cannot tell two clients
 * apart should treat them as one and refuse sooner, never invent a fresh window
 * per request — the second is how an unauthenticated endpoint ends up with no
 * brake at all.
 */
const UNKNOWN_IP = "unknown";

/**
 * How many reverse proxies sit in front of this process, each appending the
 * address it saw to `X-Forwarded-For`.
 *
 * Production is one: nginx on this box, which is also the only thing that can
 * reach the Node server at all (`HOSTNAME=127.0.0.1`, deploy/ecosystem.config.cjs
 * and the systemd unit). Development is **zero**, because `next dev` is spoken
 * to directly and there is nothing in front of it that could overwrite a header
 * — so in development no forwarding header is believed at all, which is both
 * honest and what makes the spoofing regression test meaningful.
 *
 * `TRUSTED_PROXY_HOPS` overrides it for a deployment shaped differently (a CDN
 * in front of nginx is two). Setting it to 0 on a directly-exposed server is
 * the correct answer, not a degraded one: it says "no header here is evidence".
 */
const DEFAULT_HOPS = process.env.NODE_ENV === "production" ? 1 : 0;

let cachedHops: number | null = null;

export function trustedProxyHops(): number {
  if (cachedHops !== null) return cachedHops;

  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") {
    cachedHops = DEFAULT_HOPS;
    return cachedHops;
  }

  const parsed = Number(raw);
  // An upper bound because the value indexes into a header the client can pad:
  // a nonsense 500 would walk off the front of the list and land on a value the
  // attacker wrote. Anything invalid falls back and says so once.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 8) {
    console.warn(
      `[login-throttle] TRUSTED_PROXY_HOPS=${raw} is not an integer in 0..8; using ${DEFAULT_HOPS}.`,
    );
    cachedHops = DEFAULT_HOPS;
    return cachedHops;
  }

  cachedHops = parsed;
  return cachedHops;
}

/** Only for tests, which need to exercise more than one deployment shape. */
export function resetTrustedProxyHopsCache(): void {
  cachedHops = null;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Deliberately loose: hex groups and colons, which is enough to reject prose. */
const IPV6 = /^[0-9a-f:]{2,45}$/;

/**
 * A header value as an address, or null if it is not one.
 *
 * Rejecting rather than passing through is the point. Whatever survives here
 * becomes a bucket key, and an unvalidated value is a way to mint unlimited
 * buckets — the same bypass by a different door. Anything refused falls back to
 * {@link UNKNOWN_IP}, which is stricter, never looser.
 */
function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;

  let candidate = value.trim().toLowerCase();
  if (candidate === "" || candidate.length > 64) return null;

  // `[::1]:41234` — the bracketed IPv6-with-port form some proxies write.
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) candidate = bracketed[1];
  // `203.0.113.7:41234` — IPv4 with a port. Bare IPv6 has colons of its own, so
  // this only strips a port when what is left is a complete IPv4 address.
  else if (candidate.includes(":") && IPV4.test(candidate.split(":")[0])) {
    candidate = candidate.split(":")[0];
  }

  if (IPV4.test(candidate)) {
    return candidate.split(".").every((octet) => Number(octet) <= 255) ? candidate : null;
  }
  if (candidate.includes(":") && IPV6.test(candidate)) return candidate;

  return null;
}

/**
 * The client address — the one our own proxy observed, never the one the client
 * asked us to believe.
 *
 * ---------------------------------------------------------------------------
 * What was wrong before
 * ---------------------------------------------------------------------------
 * This used to return the **leftmost** `X-Forwarded-For` entry. nginx sets
 * `X-Forwarded-For $proxy_add_x_forwarded_for` (deploy/nginx/leadportal.conf),
 * which *appends* the address it saw to whatever the client already sent — so
 * the leftmost entry is not a hop at all, it is a string the caller typed. A
 * fresh value per request meant a fresh per-IP window per request, and the
 * per-IP half of the login throttle was decorative. The same value was written
 * to `sessions.ip_address`, so the audit trail recorded the attacker's fiction.
 *
 * ---------------------------------------------------------------------------
 * What is trusted now
 * ---------------------------------------------------------------------------
 *   1. `X-Real-IP`, which nginx sets to `$remote_addr` — a single value it
 *      writes rather than extends, so there is nothing of the client's left in
 *      it. `proxy_set_header` replaces any inbound copy.
 *   2. Failing that, the **rightmost trusted hop** of `X-Forwarded-For`:
 *      `list[list.length - hops]`. With one proxy that is the last entry, the
 *      one nginx itself appended. Everything to the left of it is client input
 *      and is never read.
 *
 * Neither is consulted when {@link trustedProxyHops} is 0 — with nothing in
 * front of the server, both headers are just request headers.
 *
 * A caller can still *shorten* the list (send no header at all), and that is
 * fine: the result is {@link UNKNOWN_IP}, a bucket shared with every other
 * caller in the same position, which is more restrictive than their own.
 */
export function clientIp(request: Request): string {
  const hops = trustedProxyHops();
  if (hops === 0) return UNKNOWN_IP;

  const real = normaliseIp(request.headers.get("x-real-ip"));
  if (real) return real;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    // Count from the right. A chain shorter than the number of proxies we are
    // told to expect is not a chain we understand, and the index goes negative
    // — which yields `undefined` and therefore the shared bucket.
    const hop = chain[chain.length - hops];
    const ip = normaliseIp(hop);
    if (ip) return ip;
  }

  return UNKNOWN_IP;
}
