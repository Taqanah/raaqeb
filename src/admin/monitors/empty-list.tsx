/**
 * The monitors list's empty state: where onboarding lands.
 * It holds the page's "add monitor" button while no monitor exists, and the
 * import note, a router link to the export and import page. The page frame
 * (the shell's `Page`) carries the title, and the add button once a monitor
 * exists.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCan } from "@/admin/shell/role.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
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
  const imports = useCan("transfer");
  const adds = useCan("monitors");
  // The line says what the operator's role can do here: add one and import, add one, or wait for one.
  let description: MessageId = "monitor_empty_description_read";
  if (imports) {
    description = "monitor_empty_description";
  } else if (adds) {
    description = "monitor_empty_description_add";
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{t("monitor_empty_title")}</EmptyTitle>
        <EmptyDescription>{t(description)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {add}
        {imports ? (
          <Link
            className="text-muted-foreground text-sm underline-offset-4 hover:underline"
            to={importPagePath}
          >
            {t("monitor_import_link")}
          </Link>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}
