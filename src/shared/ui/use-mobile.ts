/**
 * Whether the viewport is narrower than the sidebar's breakpoint, read in an
 * effect after mount (ADR-0006: no browser checks in render scope), so the
 * server and the first client render agree on the desktop layout.
 */
import { useEffect, useState } from "react";

const mobileBreakpoint = 768;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${mobileBreakpoint - 1}px)`);
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return isMobile;
}
