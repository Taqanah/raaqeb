import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "./cn.ts";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn("grid w-full gap-2", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "group/radio-group-item peer relative flex aspect-square size-mark shrink-0 rounded-full border border-border-strong bg-background transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring aria-invalid:border-status-down data-disabled:cursor-not-allowed data-checked:border-action data-checked:bg-action data-checked:text-action-foreground data-disabled:opacity-50",
        className
      )}
      data-slot="radio-group-item"
      {...props}
    >
      <RadioPrimitive.Indicator
        className="flex size-mark items-center justify-center"
        data-slot="radio-group-indicator"
      >
        <span className="absolute start-1/2 top-1/2 size-[calc(var(--spacing-mark)/2)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-action-foreground rtl:translate-x-1/2" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
