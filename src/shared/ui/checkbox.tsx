import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "./cn.ts";
import { CheckIcon } from "./icons.tsx";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer relative flex size-mark shrink-0 items-center justify-center rounded-xs border border-border-strong bg-background outline-none transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring-soft disabled:cursor-not-allowed disabled:opacity-50 group-has-disabled/field:opacity-50 aria-invalid:border-status-down data-checked:border-action data-checked:bg-action data-checked:text-action-foreground",
        className
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="grid place-content-center text-current transition-none [&>svg]:size-icon-sm"
        data-slot="checkbox-indicator"
      >
        <CheckIcon strokeWidth="3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
