/**
 * Live refresh of a status page's view:
 * the view's document is read again every 60 seconds and when the window
 * regains focus, never while the tab is hidden. Only the view's own match
 * is invalidated: the root's loader answers the page the entry resolved,
 * which a server function called from the browser cannot know. The browser's own cache sends the ETag, so a
 * document that did not change comes back as a 304 from the memo.
 */
import { rootRouteId, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

export const refreshPeriodMs = 60_000;

/** Two refreshes closer than this are one: a tab coming back fires both focus and visibility. */
const settleMs = 1000;

/** Refreshes the view while `on`; a not-found passes false. */
export function useLiveRefresh(on: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!on) {
      return;
    }
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      if (now - last < settleMs) {
        return;
      }
      last = now;
      router
        .invalidate({ filter: (match) => match.routeId !== rootRouteId })
        .catch(() => undefined);
    };
    const timer = setInterval(refresh, refreshPeriodMs);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [on, router]);
}
