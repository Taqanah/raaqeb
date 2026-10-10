/**
 * The monitors list's empty state: where onboarding lands.
 * It holds the page's "add monitor" button while no monitor exists, and the
 * import note, a router link to the export and import page. The page frame
 * (the shell's `Page`) carries the title, and the add button once a monitor
 * exists.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";

const importPagePath = "/admin/settings/export";

/** `add` is the page's add button, held here while the list is empty. */
export function EmptyList({ add }: { readonly add: ReactNode }): ReactNode {
  const { t } = useMessages();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{t("monitor_empty_title")}</EmptyTitle>
        <EmptyDescription>{t("monitor_empty_description")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {add}
        <Link
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
          to={importPagePath}
        >
          {t("monitor_import_link")}
        </Link>
      </EmptyContent>
    </Empty>
  );
}
