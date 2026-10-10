import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

// The empty state: centred icon, one-line title, one-line description, primary button.
function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 text-balance rounded-xl border border-dashed p-8 text-center",
        className
      )}
      data-slot="empty"
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex max-w-sm flex-col items-center gap-2", className)}
      data-slot="empty-header"
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-10 shrink-0 items-center justify-center rounded-lg bg-subtle text-foreground [&_svg:not([class*='size-'])]:size-5",
      },
    },
  }
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      className={cn(emptyMediaVariants({ className, variant }))}
      data-slot="empty-icon"
      data-variant={variant}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("font-medium text-base", className)}
      data-slot="empty-title"
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "text-muted-foreground text-sm [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
        className
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-sm flex-col items-center gap-2.5 text-balance text-sm",
        className
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}

export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
};
