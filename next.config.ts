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
};

export default nextConfig;
