/**
 * The segmented control: two to four short options
 * side by side, one click to choose, the chosen one raised on the grey track
 * as the chart's range switch is. Underneath it is a radio group, so a form
 * reads its `name`, the arrow keys move the choice and a screen reader
 * announces a radio group. An option's optional second line says what it
 * means now (the time in that clock, what "as the install" resolves to); an
 * option without one is centred in the row's height.
 */
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";

function Segmented({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn(
        "flex w-full gap-0.5 rounded-lg bg-subtle p-0.5",
        className
      )}
      data-slot="segmented"
      {...props}
    />
  );
}

function SegmentedItem({
  children,
  className,
  hint,
  ...props
}: RadioPrimitive.Root.Props & {
  /** A second, quieter line under the label. */
  readonly hint?: ReactNode;
}) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "flex min-h-9 min-w-0 flex-1 cursor-pointer select-none flex-col items-center justify-center rounded-md px-3 py-1.5 text-center font-medium text-muted-foreground text-sm transition-[background-color,color,box-shadow] hover:text-foreground data-disabled:cursor-not-allowed data-checked:bg-segment data-checked:text-foreground data-disabled:opacity-50 data-checked:shadow-sm",
        className
      )}
      data-slot="segmented-item"
      data-value={String(props.value)}
      {...props}
    >
      <span className="flex items-center gap-2 [&_svg:not([class*='size-'])]:size-icon [&_svg]:shrink-0">
        {children}
      </span>
      {hint ? (
        <span className="font-normal text-muted-foreground text-xs tabular-nums">
          {hint}
        </span>
      ) : null}
    </RadioPrimitive.Root>
  );
}

export { Segmented, SegmentedItem };
