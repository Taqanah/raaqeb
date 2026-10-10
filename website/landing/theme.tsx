/**
 * The visitor's theme on the website: one button that turns light into
 * dark and back, kept under the key Fumadocs' switch in the docs uses, so one
 * choice holds across the site; until the visitor clicks, the device decides.
 * The script sets the class before the first paint; the button reads the
 * theme after mount (ADR-0006). The sun turns into the moon in CSS, and the
 * new theme spreads from the button through a view transition.
 */
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { Copy } from "~/copy.ts";

const key = "theme";

/** Sets .light or .dark on the root from the stored choice; the device decides otherwise. */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(key)});if(t==="light"||t==="dark")document.documentElement.classList.add(t)}catch(e){}})()`;

/** Whether the page shows dark now: the root's class, or the device's when the root has none. */
function isDark(): boolean {
  const root = document.documentElement.classList;
  return (
    root.contains("dark") ||
    (!root.contains("light") &&
      matchMedia("(prefers-color-scheme: dark)").matches)
  );
}

function apply(dark: boolean): void {
  const root = document.documentElement.classList;
  root.remove("light", "dark");
  root.add(dark ? "dark" : "light");
}

/** The sun's eight rays, as start and end points around the centre. */
const rays = [0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
  const a = (deg * Math.PI) / 180;
  const at = (r: number) =>
    `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`;
  return `M${at(8)}L${at(10)}`;
});

export function ThemeSwitch({
  copy,
}: {
  readonly copy: Copy["theme"];
}): ReactNode {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(isDark());
  }, []);
  const flip = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const next = !isDark();
    setDark(next);
    try {
      localStorage.setItem(key, next ? "dark" : "light");
    } catch {
      // Storage refused: the choice lasts for this page.
    }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || !("startViewTransition" in document)) {
      apply(next);
      return;
    }
    // The new theme grows as a circle from the button until it covers the farthest corner.
    const box = event.currentTarget.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const r = Math.hypot(
      Math.max(x, innerWidth - x),
      Math.max(y, innerHeight - y)
    );
    document
      .startViewTransition(() => apply(next))
      .ready.then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0 at ${x}px ${y}px)`,
              `circle(${r}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 520,
            easing: "cubic-bezier(0.65, 0, 0.35, 1)",
            pseudoElement: "::view-transition-new(root)",
          }
        );
      })
      .catch(() => apply(next));
  }, []);
  return (
    <button
      aria-label={copy}
      aria-pressed={dark}
      className="grid size-8 cursor-pointer place-items-center rounded-full text-muted transition-colors hover:bg-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:scale-95"
      onClick={flip}
      title={copy}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="theme-icon size-[18px]"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <mask id="theme-bite">
          <rect fill="white" height="24" width="24" />
          <circle className="theme-bite" cx="17" cy="7" fill="black" r="8" />
        </mask>
        <circle
          className="theme-core"
          cx="12"
          cy="12"
          fill="currentColor"
          mask="url(#theme-bite)"
          r="9"
          stroke="none"
        />
        <path className="theme-rays" d={rays.join("")} />
      </svg>
    </button>
  );
}
