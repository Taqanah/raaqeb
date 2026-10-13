/** Raaqeb's own mark as head links: the app's tab icon, and a status page's when it uploaded none. Files live in `public/`. */
export const raaqebIcons = [
  { href: "/favicon.svg", rel: "icon", type: "image/svg+xml" },
  { href: "/apple-touch-icon.png", rel: "apple-touch-icon" },
];

/** A status page's icon links: its own favicon, else Raaqeb's mark. */
export function faviconLinks(favicon: string | undefined) {
  return favicon ? [{ href: favicon, rel: "icon" }] : raaqebIcons;
}
