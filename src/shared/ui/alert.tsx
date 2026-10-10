import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-3 py-2.5 text-start text-sm has-data-[slot=alert-action]:relative has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 has-data-[slot=alert-action]:pe-18 *:[svg:not([class*='size-'])]:size-icon *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "border-status-down/30 bg-status-down-soft text-destructive-text *:data-[slot=alert-description]:text-destructive-text/90",
        // Something to heed before going on, in the status family's amber.
        warning:
          "border-status-degraded/40 bg-status-degraded-soft text-status-degraded-text *:data-[slot=alert-description]:text-status-degraded-text/90",
      },
    },
  }
);

function Alert({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      data-slot="alert-title"
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "text-balance text-muted-foreground text-sm md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("absolute end-2 top-2", className)}
      data-slot="alert-action"
      {...props}
    />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
