import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "./cn.ts";

// The thumb slides along the reading direction: the rtl: variants negate the
// translate, which is the mirror shadcn-ui/ui#10274 asked for; the CLI's RTL
// transform now writes it and the copy keeps it.
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent outline-none transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-4 focus-visible:ring-ring-soft aria-invalid:border-status-down data-[size=default]:h-switch-h data-[size=sm]:h-switch-sm-h data-[size=default]:w-switch-w data-[size=sm]:w-switch-sm-w data-disabled:cursor-not-allowed data-checked:bg-action data-unchecked:bg-muted-foreground/50 data-disabled:opacity-50",
        className
      )}
      data-size={size}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block rounded-full bg-background shadow-xs transition-transform duration-150 ease-out-quart data-checked:bg-action-foreground group-data-[size=default]/switch:size-switch-thumb group-data-[size=sm]/switch:size-switch-sm-thumb group-data-[size=default]/switch:data-checked:translate-x-[calc(100%+1px)] group-data-[size=default]/switch:data-unchecked:translate-x-px group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%+1px)] group-data-[size=sm]/switch:data-unchecked:translate-x-px rtl:group-data-[size=default]/switch:data-checked:-translate-x-[calc(100%+1px)] rtl:group-data-[size=default]/switch:data-unchecked:-translate-x-px rtl:group-data-[size=sm]/switch:data-checked:-translate-x-[calc(100%+1px)] rtl:group-data-[size=sm]/switch:data-unchecked:-translate-x-px"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
