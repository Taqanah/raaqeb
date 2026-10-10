import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

// The shortcut chip: a small grey chip on the end side of a
// button, in the sans face because it names a key, not a machine token.
function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-subtle in-data-[slot=tooltip-content]:bg-background/20 px-1 font-medium font-sans in-data-[slot=tooltip-content]:text-background text-2xs text-muted-foreground [&_svg:not([class*='size-'])]:size-icon-sm",
        className
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

// A chord reads left to right in every locale (Ctrl, then K), so the group is LTR;
// its own ms- and me- resolve left to right too, so place it from its siblings.
function KbdGroup({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      dir="ltr"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
