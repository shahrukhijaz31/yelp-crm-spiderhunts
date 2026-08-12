/**
 * Whether the navigation rail is collapsed, and how that survives a navigation.
 *
 * No imports on purpose, like `lib/access.ts` — this is read by a server layout
 * and by two client components, so it must stay free of `next/headers`, Prisma
 * and anything else with a runtime of its own.
 *
 * ---------------------------------------------------------------------------
 * A cookie, not localStorage
 * ---------------------------------------------------------------------------
 * The rail is rendered on the server, so the server has to know how wide it is
 * before the first byte goes out. `localStorage` can only be read after
 * hydration, which would paint a 240px rail and then snap it to 60px on every
 * single page load — the flash `next-themes` exists to avoid for the colour
 * scheme, for exactly the same reason.
 *
 * It is a preference and nothing else. It names no user, gates nothing, and is
 * read only to choose a CSS class; a forged value can make somebody's own
 * sidebar the wrong width and can do nothing else at all. That is why it is set
 * from `document.cookie` in the browser rather than through an endpoint.
 *
 * ---------------------------------------------------------------------------
 * Three states, and why "auto" is one of them
 * ---------------------------------------------------------------------------
 * The rail already collapses by viewport: 240px of labels above 1536px and a
 * 60px icon rail below it, because the worklist is a ~1460px table and that is
 * the width at which the two stop competing (see `AppShell`). That behaviour was
 * measured against the screen it contains and is a good default, so it is kept
 * as {@link NAV_MODES}`[0]` — "auto" — rather than thrown away the moment a
 * manual control exists.
 *
 * An explicit choice then wins at every width from `md` up, including the ones
 * where automatic behaviour would have decided otherwise. Somebody on a 1280px
 * laptop who wants labels has asked for labels, and a preference that silently
 * refused below a breakpoint would be a control that does nothing.
 */

export const NAV_MODES = ["auto", "collapsed", "expanded"] as const;

export type NavMode = (typeof NAV_MODES)[number];

/**
 * Plain-named and not `__Host-` prefixed, unlike the session cookie.
 *
 * `__Host-` is what stops a sibling site on this shared box from writing a
 * *session* this application would then trust. Nothing here is trusted: the
 * worst a neighbouring host could achieve by setting this is a sidebar of the
 * other width, so the prefix would buy nothing and would need the same
 * production/development split the session name carries.
 */
export const NAV_MODE_COOKIE = "lp_nav";

/** A year. It is a preference, and re-choosing it every session is the bug. */
export const NAV_MODE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * A cookie value as a mode.
 *
 * Falls back to "auto" for anything unrecognised rather than throwing — this
 * runs on a value from a request header, and the correct answer to a mangled
 * one is the default layout, never an error page.
 */
export function readNavMode(value: string | null | undefined): NavMode {
  return (NAV_MODES as readonly string[]).includes(value ?? "")
    ? (value as NavMode)
    : "auto";
}

/**
 * The classes each mode puts on the rail and the things inside it.
 *
 * Written out per mode as whole literal strings rather than assembled from
 * fragments, because Tailwind finds classes by scanning source text: a name
 * built at runtime is a name that never reaches the stylesheet.
 *
 *   width   the rail itself
 *   hide    for a label that has no room on a 60px rail — the group headings,
 *           the queue counts, the footer line
 *   srOnly  for a nav label, which leaves the DOM only in appearance: it stays
 *           in the accessible name so the icon rail is still navigable by
 *           screen reader, and `title` gives everyone else a tooltip
 *   center  a nav row with no label centres its icon and drops its padding
 */
export const NAV_MODE_CLASSES: Record<
  NavMode,
  { width: string; hide: string; srOnly: string; center: string }
> = {
  auto: {
    width: "w-[60px] 2xl:w-[240px]",
    hide: "max-2xl:hidden",
    srOnly: "max-2xl:sr-only",
    center: "max-2xl:justify-center max-2xl:px-0",
  },
  collapsed: {
    width: "w-[60px]",
    hide: "hidden",
    srOnly: "sr-only",
    center: "justify-center px-0",
  },
  expanded: {
    width: "w-[240px]",
    hide: "",
    srOnly: "",
    center: "",
  },
};

/** The viewport at which "auto" shows labels. Matches the `2xl:` breakpoint. */
export const NAV_LABEL_MIN_WIDTH = 1536;
