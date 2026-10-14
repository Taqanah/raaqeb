import {
  createRootRoute,
  HeadContent,
  Scripts,
  useLocation,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { directionOf } from "@/shared/i18n/locale.ts";
import rubikArabic from "@/shared/ui/fonts/rubik-arabic.woff2?url";
import rubikLatin from "@/shared/ui/fonts/rubik-latin.woff2?url";
import { NotFound } from "~/landing/not-found.tsx";
import { themeScript } from "~/landing/theme.tsx";
import { pathLocale } from "~/locale.ts";

const font = {
  as: "font",
  crossOrigin: "anonymous",
  rel: "preload",
  type: "font/woff2",
} as const;

export const Route = createRootRoute({
  head: () => ({
    links: [
      { href: rubikArabic, ...font },
      { href: rubikLatin, ...font },
      { href: "/favicon.svg", rel: "icon", type: "image/svg+xml" },
      { href: "/apple-touch-icon.png", rel: "apple-touch-icon" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      // The browser's chrome takes the page's paper in each theme.
      {
        content: "#f6faf9",
        media: "(prefers-color-scheme: light)",
        name: "theme-color",
      },
      {
        content: "#0a1110",
        media: "(prefers-color-scheme: dark)",
        name: "theme-color",
      },
    ],
    // The visitor's theme on the root before the first paint, the docs' key and classes, so it holds on every page.
    scripts: [{ children: themeScript }],
  }),
  // The build writes it as each locale's 404.html, which the static host serves for an address that is no file.
  notFoundComponent: NotFound,
  shellComponent: Document,
});

// The path's locale sets the document's language and direction, a path that names no page included.
function Document({ children }: { readonly children: ReactNode }): ReactNode {
  const shown = useLocation({ select: (l) => pathLocale(l.pathname) });
  return (
    // The theme script in the head sets .light or .dark on the root before React loads.
    <html dir={directionOf(shown)} lang={shown} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
