import { Prisma } from "./generated/prisma/client";
import { prisma } from "./prisma";

/**
 * A brake on the expensive things a signed-in person can ask for.
 *
 * ---------------------------------------------------------------------------
 * What this is for, and what it is not
 * ---------------------------------------------------------------------------
 * Every endpoint behind this limiter is already authenticated and already
 * authorized: an administrator may import a CSV, and nothing here changes that.
 * What it stops is the *rate*, which authorization has nothing to say about — a
 * script holding one valid session cookie replaying the export screen or the
 * search query in a loop is a denial of service against everybody else's
 * portal, performed by a caller who is allowed to make each individual request.
 *
 * The four endpoints chosen are the ones where a single request costs the
 * server real work:
 *
 *   search            a `LIKE '%…%'` across the whole leads table
 *   export            the export screen reads every lead in one go
 *   import            parses and merges up to 8MB of CSV inside one request
 *   screenshot delete up to 500 rows and 500 files per call
 *
 * The limits are deliberately loose. They are set where a person working
 * normally — even quickly, even with several tabs open — never meets them, and
 * a loop does within seconds. A limiter that interrupts an administrator doing
 * their job would be removed within a week, and then there would be none.
 *
 * ---------------------------------------------------------------------------
 * In Postgres, for the reason the screenshot limiter gives
 * ---------------------------------------------------------------------------
 * `lib/loginThrottle.ts` keeps its windows in a `Map` and is honest that this
 * is not a distributed limiter; that is a fair trade there, where the real
 * brake is scrypt. It is the wrong trade here. The portal runs two PM2 workers
 * and two blue/green slots during a deploy, so an in-process counter would give
 * each caller as many windows as there are processes and drop them all on
 * restart. `lib/screenshotRateLimit.ts` already solved this with one row and
 * one conditional statement, and this is the same shape generalised.
 *
 * ---------------------------------------------------------------------------
 * One statement, therefore atomic
 * ---------------------------------------------------------------------------
 * The claim is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so two
 * workers racing the same key are serialised by the row lock Postgres takes for
 * the update, and the count each one reads back is the count after its own
 * increment. There is no read-then-write to lose, no transaction spanning the
 * work being limited, and nothing to clean up if a process dies mid-request.
 *
 * Both clocks are the database's. `now()` decides when a window opened and
 * `now()` decides whether it has closed, so the two PM2 workers cannot disagree
 * about a window because their system clocks differ.
 */

export interface RateLimitRule {
  /** Bucket prefix, so two actions by the same person never share a window. */
  action: string;
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
}

/**
 * GET /api/leads with a search term.
 *
 * The search box is debounced at 300ms and every other filter is a single
 * click, so a person generates a handful of these a minute. 120 leaves two a
 * second sustained, across every tab they have open.
 */
export const LEAD_SEARCH_LIMIT: RateLimitRule = {
  action: "lead-search",
  limit: 120,
  windowSeconds: 60,
};

/**
 * The Export Data screen, which reads every lead in the table to render.
 *
 * 30 in five minutes is a page load every ten seconds, sustained — far past
 * anyone picking rows and choosing a format, and far short of a loop.
 */
export const LEAD_EXPORT_LIMIT: RateLimitRule = {
  action: "lead-export",
  limit: 30,
  windowSeconds: 5 * 60,
};

/**
 * POST /api/leads/upload — an 8MB CSV parsed and merged inside the request.
 *
 * The expensive one, and the rarest: an import is a deliberate act performed a
 * few times a day at most. Ten in ten minutes covers a bad file being corrected
 * and retried repeatedly, which is the only realistic burst.
 */
export const LEAD_IMPORT_LIMIT: RateLimitRule = {
  action: "lead-import",
  limit: 10,
  windowSeconds: 10 * 60,
};

/**
 * DELETE /api/admin/screenshots — up to 500 rows and 500 files per call.
 *
 * 20 in five minutes is still 10,000 screenshots in five minutes, so a real
 * clear-out is not obstructed; what it costs is the ability to sit in a loop
 * issuing 500-file deletions.
 */
export const SCREENSHOT_BULK_DELETE_LIMIT: RateLimitRule = {
  action: "screenshot-bulk-delete",
  limit: 20,
  windowSeconds: 5 * 60,
};

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window closes. Sent as `Retry-After`. */
  retryAfterSeconds: number;
  /** Requests counted in the current window, this one included. */
  count: number;
}

/**
 * Count this request against the caller's window and say whether to serve it.
 *
 * `subject` is the user id from the session — never anything the client sent.
 * There is no parameter here a request could use to be counted as somebody
 * else, because the caller does not name the bucket.
 *
 * Fails **open** on a database error, and that is the opposite of what
 * `lib/screenshotRateLimit.ts` does — deliberately, because the two are
 * protecting against different things. That one is the enforcement of a
 * monitoring policy against a client that may be hostile, so it must not wave
 * anything through. This one is a fairness brake in front of endpoints that are
 * already authenticated and already authorized; if Postgres is unreachable then
 * the endpoint behind this is about to fail on its own, and turning a database
 * blip into "the administrator cannot import" adds an outage rather than
 * preventing one. The failure is logged so it cannot be silent.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitVerdict> {
  const key = `${rule.action}:${subject}`;

  try {
    const rows = await prisma.$queryRaw<Array<{ count: number; window_started_at: Date }>>(
      Prisma.sql`
        INSERT INTO rate_limits (key, window_started_at, count)
        VALUES (${key}, now(), 1)
        ON CONFLICT (key) DO UPDATE SET
          count =
            CASE
              WHEN rate_limits.window_started_at
                     <= now() - make_interval(secs => ${rule.windowSeconds}::double precision)
              THEN 1
              ELSE rate_limits.count + 1
            END,
          window_started_at =
            CASE
              WHEN rate_limits.window_started_at
                     <= now() - make_interval(secs => ${rule.windowSeconds}::double precision)
              THEN now()
              ELSE rate_limits.window_started_at
            END
        RETURNING count, window_started_at
      `,
    );

    const row = rows[0];
    if (!row) {
      // Cannot happen — `RETURNING` on an upsert always yields the row — but a
      // limiter that throws is worse than one that abstains.
      console.error("[rate-limit] upsert returned no row for", rule.action);
      return { allowed: true, retryAfterSeconds: 0, count: 0 };
    }

    const elapsedMs = Date.now() - row.window_started_at.getTime();
    const remaining = Math.ceil((rule.windowSeconds * 1000 - elapsedMs) / 1000);

    return {
      allowed: row.count <= rule.limit,
      retryAfterSeconds: Math.min(Math.max(remaining, 1), rule.windowSeconds),
      count: row.count,
    };
  } catch (error) {
    console.error(`[rate-limit] could not count ${rule.action}:`, error);
    return { allowed: true, retryAfterSeconds: 0, count: 0 };
  }
}

/**
 * The 429 to send when a verdict refuses.
 *
 * One message for all four endpoints, and it says nothing about the limit or
 * how much of it is left: a caller probing for the shape of the brake learns
 * only that there is one.
 */
export function tooManyRequestsJson(verdict: RateLimitVerdict): Response {
  return Response.json(
    {
      error: "rate_limited",
      message: "That is a lot of requests at once. Try again in a moment.",
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(verdict.retryAfterSeconds),
      },
    },
  );
}

/**
 * Count and refuse in one call, for a handler that has nothing else to do with
 * the verdict. Returns the response to send, or null to carry on.
 */
export async function rateLimitRefusal(
  rule: RateLimitRule,
  subject: string,
): Promise<Response | null> {
  const verdict = await consumeRateLimit(rule, subject);
  return verdict.allowed ? null : tooManyRequestsJson(verdict);
}
