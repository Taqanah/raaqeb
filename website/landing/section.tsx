/**
 * The landing's shared pieces: the section head, a product frame,
 * and a code line with its copy button, typographic, no window chrome.
 */
import {
  type ChangeEvent,
  type ComponentProps,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { CheckIcon, CopyIcon } from "@/shared/ui/icons.tsx";

declare module "react" {
  interface CSSProperties {
    /** An element's place in its group, which staggers its animation (website/styles.css). */
    "--i"?: number;
  }
}

/** The backgrounds a section can sit on. */
export type Backdrop = "dots" | "grid" | "blueprint";

export function Section({
  children,
  id,
  lead,
  backdrop,
  title,
  tight = false,
}: {
  /** The section's background behind its content (website/styles.css): a texture faded at its top and bottom. */
  readonly backdrop?: Backdrop;
  readonly children: ReactNode;
  readonly id: string;
  readonly lead?: string;
  /** The section's claim; the words between asterisks take the brand's colour. */
  readonly title: string;
  /** Less room above, for a section that follows a frame closely. */
  readonly tight?: boolean;
}): ReactNode {
  return (
    <section
      className={`${tight ? "pt-32" : "pt-48"} ${backdrop ? `backdrop backdrop-${backdrop} pb-32` : "pb-12"} max-md:pt-24`}
      id={id}
    >
      <div className="mx-auto max-w-[1200px] px-6">
        <h2 className="max-w-[13em] text-balance font-medium text-[clamp(36px,5.2vw,72px)] leading-[1.06] tracking-[-0.035em] [&:lang(ar)]:leading-[1.3] [&:lang(ar)]:tracking-normal">
          {title.split("*").map((part, n) =>
            // The words between asterisks take the brand's colour, as «راقب» does in the hero.
            n % 2 ? (
              <span className="text-teal-text" key={part}>
                {part}
              </span>
            ) : (
              part
            )
          )}
        </h2>
        {lead ? (
          <p className="mt-8 max-w-[36em] text-pretty text-[clamp(18px,1.55vw,21px)] leading-[1.6]">
            {lead}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

/**
 * A product frame: the product surface itself, which may extend past the
 * page's end edge.
 */
export function Frame({
  children,
  className = "",
  clip = false,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  /** Whether the frame runs past the end edge of the page, as the hero's does. */
  readonly clip?: boolean;
}): ReactNode {
  return (
    <figure
      className={`mt-16 ${clip ? "me-[-10vw] max-lg:me-0" : ""} ${className}`}
    >
      <div className="overflow-hidden rounded-xl bg-surface ring-line">
        {children}
      </div>
    </figure>
  );
}

/** The radio an event in a group came from. */
export function chosenValue(event: ChangeEvent<HTMLElement>): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

/** A command, left to right, on its own surface, with a button that copies it. */
export function CodeLine({
  code,
  copied,
  copy,
  wrap = false,
  ...rest
}: ComponentProps<"div"> & {
  readonly code: string;
  readonly copied: string;
  readonly copy: string;
  /** Whether a long command wraps onto more lines instead of scrolling within one. */
  readonly wrap?: boolean;
}): ReactNode {
  const [done, setDone] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => setDone(true))
      .catch(() => setDone(false));
  }, [code]);
  const label = done ? copied : copy;
  return (
    <div
      className="flex w-fit max-w-full items-center gap-4 rounded-lg bg-surface py-1.5 ps-4 pe-1.5 text-[14px] shadow-[0_8px_24px_-16px_oklch(0%_0_0/0.3)] ring-line"
      {...rest}
    >
      <pre
        className={`token m-0 min-w-0 flex-1 select-all text-start ${wrap ? "wrap-anywhere whitespace-pre-wrap" : "overflow-x-auto whitespace-nowrap"} text-[12.5px] text-strong leading-[1.6] [scrollbar-width:none]`}
      >
        <span className="text-teal-text">$ </span>
        {code}
      </pre>
      <button
        className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] text-muted transition-colors hover:bg-soft hover:text-fg active:translate-y-px"
        onClick={onCopy}
        type="button"
      >
        {done ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
        <span>{label}</span>
      </button>
    </div>
  );
}

/** Whether a section has come into view once; the demos inside play then. */
export function useSeen(): readonly [
  (node: HTMLElement | null) => void,
  boolean,
] {
  const [seen, setSeen] = useState(false);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          watcher.disconnect();
        }
      },
      { threshold: 0.35 }
    );
    watcher.observe(node);
  }, []);
  return [ref, seen];
}
