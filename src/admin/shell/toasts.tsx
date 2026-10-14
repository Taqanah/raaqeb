/**
 * The admin's toasts: a save that leaves its page says it went
 * through here, at the bottom of the screen on the end side, since the form
 * that held the line is gone. Base UI's toast announces each one politely and
 * closes it after five seconds. A refusal is never a toast: it stays beside
 * the form it is about.
 */
import { Toast } from "@base-ui/react/toast";
import { type ReactNode, useCallback } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { CheckIcon, XIcon } from "@/shared/ui/icons.tsx";

/** The shell's toast region around the admin pages. */
export function Toasts({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Toast.Provider limit={1}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          aria-label={t("app_toasts")}
          className="fixed inset-x-4 bottom-4 z-50 flex flex-col sm:start-auto sm:end-4 sm:w-96"
          data-slot="toasts"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList(): ReactNode {
  const { t } = useMessages();
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      className="flex items-center gap-3 rounded-xl bg-popover p-4 text-popover-foreground shadow-lg ring-(--rim) ring-1 transition-[opacity,transform] duration-200 data-ending-style:translate-y-2 data-starting-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:opacity-0"
      data-slot="toast"
      key={toast.id}
      toast={toast}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-action text-action-foreground">
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </span>
      <Toast.Title className="min-w-0 flex-1 font-medium text-sm" />
      <Toast.Close
        aria-label={t("app_close")}
        className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-4" />
      </Toast.Close>
    </Toast.Root>
  ));
}

/** Says a save went through, once its page is left behind. */
export function useSavedToast(): (title: string) => void {
  const { add } = Toast.useToastManager();
  return useCallback(
    (title: string) => {
      add({ title });
    },
    [add]
  );
}
