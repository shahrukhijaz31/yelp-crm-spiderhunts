import type { NextConfig } from "next";

/**
 * The application's security headers.
 *
 * ---------------------------------------------------------------------------
 * Why they moved here
 * ---------------------------------------------------------------------------
 * They were only in `deploy/nginx/leadportal.conf`, which meant the protection
 * was a property of one box's proxy configuration rather than of this
 * application. Two consequences, both real:
 *
 *   * `add_header` in nginx does not inherit — it *replaces* the inherited set
 *     for the block it appears in. The `/_next/static/` location set only
 *     `Cache-Control`, so every script and stylesheet the portal loads was
 *     served with no CSP, no `nosniff` and no `X-Frame-Options` at all. (That
 *     block now repeats the full set as well; this file is what makes it
 *     redundant rather than load-bearing.)
 *   * Anything that runs the app without that vhost in front of it — a second
 *     environment, a rollback to a machine provisioned earlier, `next start`
 *     on a laptop — had no headers whatsoever.
 *
 * The policy below is the deployed one, header for header. Nothing is loosened.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately absent
 * ---------------------------------------------------------------------------
 * `Strict-Transport-Security`. HSTS is a statement about the *transport*, and
 * the transport is not this process's: TLS terminates at nginx, and the app
 * itself is spoken to over plain http on loopback. nginx keeps it (scoped to
 * this host, no `includeSubDomains`, for the reason its own comment gives).
 * Sending it from here as well would put a promise about certificates in the
 * hands of a process that has none — and would send it in development, where
 * one wrong `max-age` pins localhost to https in the developer's browser for a
 * year.
 */
const isProduction = process.env.NODE_ENV === "production";

/**
 * `unsafe-eval` and the websocket are for `next dev` only.
 *
 * Development compiles in the browser and hot-reloads over a websocket, and
 * neither works under the production policy. The two additions are appended in
 * development and cannot reach a deployment: `next build` sets NODE_ENV to
 * production, and so does the systemd unit that runs the result.
 *
 * `unsafe-inline` in `script-src` is in the *production* policy and is not new
 * here — Next ships an inline bootstrap script and `next/font` injects inline
 * CSS. `unsafe-eval` is not, and nothing in the built app needs it.
 */
const scriptSrc = isProduction
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const connectSrc = isProduction ? "connect-src 'self'" : "connect-src 'self' ws: wss:";

const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  // `blob:` is what the export downloads and the screenshot viewer are built
  // on; `data:` covers the inline icons.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  connectSrc,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Kept alongside `frame-ancestors 'none'` above, which supersedes it in every
  // current browser — this is for the ones that never implemented CSP framing.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  /**
   * Applied to everything this server answers, `/_next/static/*` included —
   * which is the half nginx was dropping. One matcher rather than several, so
   * no response can pick up two copies of the same header.
   */
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  /**
   * Build a self-contained server into `.next/standalone`, including only the
   * `node_modules` files the traced code actually reaches.
   *
   * This is what makes the release-directory deploy work: each release is a
   * complete, runnable tree, so `npm ci` never runs on the VPS at deploy time
   * and a rollback is a symlink swap rather than a reinstall. It also means a
   * half-finished install can never break the version currently serving.
   */
  output: "standalone",

  /**
   * nginx compresses instead. Leaving this on would have Node gzip every
   * response only for nginx to receive it already-encoded and pass it through
   * — paying the CPU on the process that should be spending it on rendering,
   * and foreclosing a later switch to brotli at the edge.
   */
  compress: false,

  /** Nothing is gained by advertising the framework and version to scanners. */
  poweredByHeader: false,

  experimental: {
    /**
     * How much of a request body Next will buffer when a proxy is in play.
     *
     * `proxy.ts` runs on every request, and to let both it and the route
     * handler read a body Next clones and buffers it — capped at 10MB by
     * default, and **silently**: past the cap the handler is simply handed a
     * truncated body, with a warning in the server log and nothing at all to
     * the client. A 25MB call recording arrived as 10MB of unparseable
     * multipart and came back as "invalid body", which is the wrong answer to
     * a perfectly good upload.
     *
     * 40MB because that is what nginx already admits on its largest route
     * (`/api/leads/ingest`, deploy/nginx/leadportal.conf), so this cannot let
     * through anything the edge was not going to let through anyway. It also
     * un-truncates that ingest route, whose own 32MB limit had quietly been a
     * 10MB one ever since the proxy was added.
     */
    proxyClientMaxBodySize: "40mb",
  },
};

export default nextConfig;
