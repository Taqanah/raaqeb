/**
 * What an admin address nothing matches shows: the page frame, so the
 * sidebar stays, a title row saying so, and the way back to the monitors.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "@/shared/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@/shared/ui/empty.tsx";
import { Page } from "./page.tsx";

export function PageMissing(): ReactNode {
  const { t } = useMessages();
  return (
    <Page title={t("app_not_found_title")}>
      <Empty data-slot="page-missing">
        <EmptyHeader>
          <EmptyDescription>{t("app_not_found_description")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            data-slot="missing-back"
            nativeButton={false}
            render={<Link to="/admin/monitors" />}
            variant="outline"
          >
            {t("app_not_found_back")}
          </Button>
        </EmptyContent>
      </Empty>
    </Page>
  );
}
