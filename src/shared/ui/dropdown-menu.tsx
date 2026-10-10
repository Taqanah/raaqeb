import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";
import { popupTransition } from "./motion.ts";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            popupTransition,
            "z-50 max-h-(--available-height) min-w-40 overflow-y-auto overflow-x-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md outline-none ring-(--rim) ring-1",
            className
          )}
          data-slot="dropdown-menu-content"
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-[variant=destructive]:text-destructive-text data-disabled:opacity-50 data-[variant=destructive]:focus:bg-status-down-soft data-[variant=destructive]:focus:text-destructive-text [&_svg:not([class*='size-'])]:size-icon [&_svg]:pointer-events-none [&_svg]:shrink-0 data-[variant=destructive]:*:[svg]:text-destructive-text",
        className
      )}
      data-slot="dropdown-menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "ms-auto text-muted-foreground text-xs group-focus/dropdown-menu-item:text-accent-foreground",
        className
      )}
      data-slot="dropdown-menu-shortcut"
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
};
