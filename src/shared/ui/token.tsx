/**
 * The token component: every machine token, a URL, a host, a port,
 * a status code, a header, an id, renders through it as an isolated
 * left-to-right run in the monospace face, never bare inside a sentence.
 * Numbers with units stay inline and never use it.
 */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

export type TokenProps = ComponentProps<"bdi">;

// `bdi` isolates the run from the surrounding bidi text; `dir` is fixed after
// the spread so a caller cannot turn a token right to left.
export function Token({ className, ...props }: TokenProps): ReactNode {
  return (
    <bdi
      className={cn(
        "rounded-sm bg-muted px-1 py-px font-mono text-[0.9em] text-foreground",
        className
      )}
      data-slot="token"
      {...props}
      dir="ltr"
    />
  );
}
