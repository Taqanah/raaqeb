import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { backdropTransition, dialogTransition } from "./motion.ts";

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  );
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm";
}) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        className={cn(
          backdropTransition,
          "fixed inset-0 isolate z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs"
        )}
        data-slot="alert-dialog-overlay"
      />
      <AlertDialogPrimitive.Popup
        className={cn(
          dialogTransition,
          "group/alert-dialog-content fixed start-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-5 text-popover-foreground shadow-lg outline-none ring-(--rim) ring-1 data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-md rtl:translate-x-1/2",
          className
        )}
        data-size={size}
        data-slot="alert-dialog-content"
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-start",
        className
      )}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted p-4 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
        className
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("font-semibold text-base", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      className={cn(
        "text-balance text-muted-foreground text-sm md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

// The action confirms and closes; the caller's onClick runs before the close.
function AlertDialogAction({
  className,
  variant = "default",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      className={cn(className)}
      data-slot="alert-dialog-action"
      render={<Button size={size} variant={variant} />}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      className={cn(className)}
      data-slot="alert-dialog-cancel"
      render={<Button size={size} variant={variant} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
