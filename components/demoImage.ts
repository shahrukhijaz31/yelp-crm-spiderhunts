import type { DemoWebsiteCard } from "@/lib/demoWebsiteRules";

/**
 * Where a demo image is fetched from.
 *
 * One function, because the URL is built in four places — the table thumbnail,
 * the detail window, the full-size overlay and the edit form's preview — and
 * three of them getting the cache-busting right while the fourth does not is
 * exactly how a replaced image goes on showing the old picture to one person.
 *
 * **There is no filesystem path in here.** The only thing that identifies the
 * object is the demo website's own id; the storage key never leaves the server
 * and never appears in a payload (see `CARD_FIELDS` in `lib/demoWebsites.ts`).
 * The route behind this URL authorizes every request.
 *
 * `?v=` is the image's `updatedAt`, which changes when — and only when — the
 * image is replaced. Responses here are `no-store` (the proxy stamps it over
 * everything authenticated), so this is not fighting an HTTP cache — it is
 * changing the `src` string, which is what makes React and the browser treat a
 * replaced image as a different resource rather than reusing the decoded one
 * already in memory. Without it, uploading a new image leaves the old picture
 * on screen until a reload.
 *
 * The server never reads the parameter.
 */
export function demoImageSrc(demoWebsite: DemoWebsiteCard): string {
  const version = demoWebsite.image ? encodeURIComponent(demoWebsite.image.updatedAt) : "";
  return `/api/demo-websites/${demoWebsite.id}/image?v=${version}`;
}
