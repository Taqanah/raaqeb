/**
 * What an admin page shows when its read or its render failed: the
 * page frame, so the sidebar stays, its title row saying so, and the notice
 * with "try again" below.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { ErrorNotice } from "@/shared/ui/page-error.tsx";
import { Page } from "./page.tsx";

export function PageError(): ReactNode {
  const { t } = useMessages();
  return (
    <Page title={t("app_error_title")}>
      <ErrorNotice titled={false} />
    </Page>
  );
}
