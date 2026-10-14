import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "./cn.ts";
import { CheckIcon, MinusIcon } from "./icons.tsx";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer relative flex size-mark shrink-0 items-center justify-center rounded-xs border border-border-strong bg-background transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 group-has-disabled/field:opacity-50 aria-invalid:border-status-down data-checked:border-action data-checked:bg-action data-checked:text-action-foreground data-indeterminate:border-action data-indeterminate:bg-action data-indeterminate:text-action-foreground",
        className
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="grid place-content-center text-current transition-none [&>svg]:size-icon-sm"
        data-slot="checkbox-indicator"
      >
        {/* Some of a set chosen (a list's select-all) reads as a dash. */}
        <CheckIcon className="in-data-indeterminate:hidden" strokeWidth="3" />
        <MinusIcon
          className="in-data-indeterminate:block hidden"
          strokeWidth="3"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
