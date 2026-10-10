import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { XIcon } from "./icons.tsx";
import { backdropTransition, dialogTransition } from "./motion.ts";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  const { t } = useMessages();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          backdropTransition,
          "fixed inset-0 isolate z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs"
        )}
        data-slot="dialog-overlay"
      />
      <DialogPrimitive.Popup
        className={cn(
          dialogTransition,
          "fixed start-1/2 top-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-5 text-popover-foreground text-sm shadow-lg outline-none ring-(--rim) ring-1 sm:max-w-md rtl:translate-x-1/2",
          className
        )}
        data-slot="dialog-content"
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
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
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 pe-8", className)}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const { t } = useMessages();
  return (
    <div
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted p-4 sm:flex-row sm:justify-end",
        className
      )}
      data-slot="dialog-footer"
      {...props}
    >
      {children}
      {showCloseButton ? (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          {t("app_close")}
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("font-semibold text-base leading-snug", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn(
        "text-muted-foreground text-sm *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
