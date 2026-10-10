import type { ComponentProps } from "react";
import { cn } from "./cn.ts";
import { ChevronDownIcon } from "./icons.tsx";

type NativeSelectProps = Omit<ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
};

function NativeSelect({
  className,
  dir,
  size = "default",
  ...props
}: NativeSelectProps) {
  return (
    // The wrapper takes the select's direction too, so the arrow sits on the side its padding leaves free.
    <div
      className={cn(
        "group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className
      )}
      data-size={size}
      data-slot="native-select-wrapper"
      dir={dir}
    >
      <select
        className="h-control w-full min-w-0 select-none appearance-none rounded-lg border border-input bg-background py-1 ps-3 pe-9 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring-soft disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-status-down"
        data-size={size}
        data-slot="native-select"
        dir={dir}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute end-3 top-1/2 size-icon -translate-y-1/2 select-none text-muted-foreground"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: ComponentProps<"option">) {
  return (
    <option
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      data-slot="native-select-option"
      {...props}
    />
  );
}

function NativeSelectOptGroup({
  className,
  ...props
}: ComponentProps<"optgroup">) {
  return (
    <optgroup
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      data-slot="native-select-optgroup"
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
