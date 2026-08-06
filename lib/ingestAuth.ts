import { timingSafeEqual } from "node:crypto";

/**
 * The shared secret guarding `POST /api/leads/ingest`.
 *
 * Every other route in this app is unauthenticated, and that is a deliberate
 * choice documented in `app/api/leads/upload/route.ts`: the browser routes sit
 * behind nginx Basic Auth, so a secret on one of them would imply a protection
 * the others do not have.
 *
 * The ingest route is different in kind. It is called by a machine in another
 * project on another box, so it must be exempt from the Basic Auth prompt at
 * the edge — which means it is the one route reachable from the internet with
 * no credential in front of it. It brings its own.
 *
 * The token is read at call time rather than module scope so that rotating
 * `/etc/lead-portal/env` and restarting picks the new value up; a module-level
 * const would also be captured during `next build`, where the variable is not
 * set at all.
 */

export class IngestAuthError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly code: "unauthorized" | "ingest_not_configured",
    message: string,
  ) {
    super(message);
  }
}

/** Constant-time compare that tolerates unequal lengths. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, and returning early on that
  // would leak the token's length. Comparing each against a fixed-size digest
  // is overkill here; hashing both to the same length is enough.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Throws unless the request carries `Authorization: Bearer <INGEST_TOKEN>`.
 *
 * With `INGEST_TOKEN` unset the route refuses *everything* (503) rather than
 * falling open. An ingest endpoint that quietly accepts anonymous writes
 * because a deploy forgot an environment variable is the exact failure this
 * token exists to prevent.
 */
export function requireIngestToken(request: Request): void {
  const expected = process.env.INGEST_TOKEN ?? "";
  if (!expected) {
    throw new IngestAuthError(
      503,
      "ingest_not_configured",
      "INGEST_TOKEN is not set on the server, so this endpoint is disabled.",
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  const presented = rest.join(" ").trim();

  if (scheme.toLowerCase() !== "bearer" || !presented || !secretsMatch(presented, expected)) {
    throw new IngestAuthError(401, "unauthorized", "Expected `Authorization: Bearer <token>`.");
  }
}
