/**
 * The form's page when its read was refused: the database did not answer,
 * or the monitor's stored settings do not fit this version, named by id.
 */
import type { ReactNode } from "react";
import { Page } from "@/admin/shell/page.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { MonitorFormResult } from "@/shared/schemas/monitor.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

export function FormRefused({
  refusal,
}: {
  readonly refusal: Extract<MonitorFormResult, { ok: false }>;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Page
      parent={{ label: t("monitor_list_title"), to: "/admin/monitors" }}
      title={t("monitor_edit_title")}
    >
      <Alert variant="destructive">
        <AlertDescription>
          {refusal.reason === "corrupt" ? (
            <>
              {t("monitor_form_corrupt")} <Token>{refusal.id}</Token>
            </>
          ) : (
            t("monitor_unavailable")
          )}
        </AlertDescription>
      </Alert>
    </Page>
  );
}
