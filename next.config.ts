import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
