import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

function Textarea({
  className,
  dir,
  value,
  ...props
}: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "field-sizing-content flex min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring-soft disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-status-down aria-invalid:ring-4 aria-invalid:ring-status-down/15",
        className
      )}
      data-slot="textarea"
      // An empty free-text field follows the page: "auto" reads an empty value as left to right.
      dir={dir === "auto" && value === "" ? undefined : dir}
      value={value}
      {...props}
    />
  );
}

export { Textarea };
