import type { DemoSummary } from "@/lib/demoWebsiteRules";

/**
 * Where a lead's demo image is fetched from.
 *
 * One function, because the URL is built in three places — the table cell, the
 * workspace panel and the full-size overlay — and two of them getting the
 * cache-busting right while the third does not is exactly how a replaced image
 * goes on showing the old picture to one person.
 *
 * **There is no filesystem path in here.** The only thing that identifies the
 * object is the *lead's* own id; the storage key never leaves the server and
 * never appears in a payload (see `SUMMARY_FIELDS` in `lib/demoWebsites.ts`).
 * The route behind this URL authorizes every request against the Demo Websites
 * module.
 *
 * `?v=` is the image's `updatedAt`, which changes when — and only when — the
 * image is replaced. Responses are `no-store`, so this is not fighting an HTTP
 * cache; it changes the `src` string, which is what makes React and the browser
 * treat a replaced image as a different resource rather than reusing the
 * decoded one already in memory. Without it, uploading a new image leaves the
 * old picture on screen until a reload.
 *
 * The server never reads the parameter.
 */
export function demoImageSrc(leadId: string, demo: DemoSummary | null): string {
  const version = demo?.image ? encodeURIComponent(demo.image.updatedAt) : "";
  return `/api/leads/${leadId}/demo/image?v=${version}`;
}
