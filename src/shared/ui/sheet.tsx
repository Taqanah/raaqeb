import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { XIcon } from "./icons.tsx";
import { backdropTransition } from "./motion.ts";

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** A sheet's side is logical: `end` is the far edge in the reading direction. */
export type SheetSide = "top" | "end" | "bottom" | "start";

// Each side slides in from its own edge over 200 ms. The start and end
// translations carry rtl: mirrors because translate-x is a physical axis.
const sideClasses: Record<SheetSide, string> = {
  bottom:
    "inset-x-0 bottom-0 h-auto border-t data-starting-style:translate-y-10 data-ending-style:translate-y-10",
  end: "inset-y-0 end-0 h-full w-3/4 border-s sm:max-w-sm data-starting-style:translate-x-10 data-ending-style:translate-x-10 rtl:data-starting-style:-translate-x-10 rtl:data-ending-style:-translate-x-10",
  start:
    "inset-y-0 start-0 h-full w-3/4 border-e sm:max-w-sm data-starting-style:-translate-x-10 data-ending-style:-translate-x-10 rtl:data-starting-style:translate-x-10 rtl:data-ending-style:translate-x-10",
  top: "inset-x-0 top-0 h-auto border-b data-starting-style:-translate-y-10 data-ending-style:-translate-y-10",
};

function SheetContent({
  className,
  children,
  side = "end",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: SheetSide;
  showCloseButton?: boolean;
}) {
  const { t } = useMessages();
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        className={cn(
          backdropTransition,
          "fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs"
        )}
        data-slot="sheet-overlay"
      />
      <SheetPrimitive.Popup
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-popover-foreground text-sm shadow-lg transition-[opacity,transform] duration-200 ease-out-quart data-ending-style:opacity-0 data-starting-style:opacity-0",
          sideClasses[side],
          className
        )}
        data-side={side}
        data-slot="sheet-content"
        {...props}
      >
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                className="absolute end-3 top-3"
                size="icon"
                variant="ghost"
              />
            }
          >
            <XIcon />
            <span className="sr-only">{t("app_close")}</span>
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1 p-5 pe-14", className)}
      data-slot="sheet-header"
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      className={cn("font-semibold text-base text-foreground", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
