/**
 * The notification hold's banner (CONTEXT.md "Notification hold"): one line
 * above every admin page while an import's hold lasts, with the button that
 * ends it for an operator whose role may.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Alert, AlertTitle } from "@/shared/ui/alert.tsx";
import { Button } from "@/shared/ui/button.tsx";

export interface HoldBannerProps {
  /** Whether the last try to end it failed, which the banner says beside its button. */
  readonly failed?: boolean;
  /** Ends the hold; absent for a role that may not, which then sees no button. */
  readonly onEnd: (() => void) | undefined;
  /** Whether the end is under way. */
  readonly pending: boolean;
}

export function HoldBanner({
  failed = false,
  onEnd,
  pending,
}: HoldBannerProps): ReactNode {
  const { t } = useMessages();
  return (
    <Alert
      className="rounded-none border-x-0 border-t-0"
      data-slot="hold-banner"
    >
      <AlertTitle className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>{t("app_hold_banner")}</span>
        {onEnd ? (
          <Button
            data-slot="end-hold"
            disabled={pending}
            onClick={onEnd}
            size="sm"
            variant="outline"
          >
            {t("app_hold_end")}
          </Button>
        ) : null}
        {failed ? (
          <span className="text-destructive-text text-sm" role="alert">
            {t("app_hold_end_failed")}
          </span>
        ) : null}
      </AlertTitle>
    </Alert>
  );
}
