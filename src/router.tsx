import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
import { RouteError } from "./routes/-error.tsx";
import { ViewMissing } from "./routes/-missing.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({
    // A failed route speaks the catalog, never the router's English default.
    defaultErrorComponent: RouteError,
    // Every not-found speaks the catalog, never the router's English default.
    defaultNotFoundComponent: ViewMissing,
    // A read under 300 ms renders as it lands; a slower one shows its pending component, held 100 ms so it never flashes (Fly reads measured 156 to 257 ms).
    defaultPendingMinMs: 100,
    defaultPendingMs: 300,
    // A link's target is read on hover or focus, so the click finds it ready; the links a visitor sees opt out: the public views (src/public/link.tsx) and the auth pages (src/admin/auth/).
    defaultPreload: "intent",
    routeTree,
    scrollRestoration: true,
    // Every inline script and style element of the render carries the nonce its answer's policy names; the browser reads it back from the document.
    ssr: { nonce: renderNonce() },
  });
}

/** The nonce the entry made for this render; nothing outside a request, as for the entry's own router that only matches paths, and nothing under `vite dev`, which sends no policy. */
function renderNonce(): string | undefined {
  try {
    return getGlobalStartContext()?.nonce;
  } catch {
    // Start throws when no request is running.
    return undefined;
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
