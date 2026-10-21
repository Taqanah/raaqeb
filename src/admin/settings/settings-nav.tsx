/**
 * The settings area's pages as a row of links under the title: general,
 * appearance, account, sign-in, single sign-on, storage, metrics, locations,
 * export and import, and the setup check, each shown to the roles that open it.
 */
import { Link, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAllows } from "@/admin/shell/role.tsx";
import type { Permission } from "@/shared/domain/roles.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { cn } from "@/shared/ui/cn.ts";

const trailingSlash = /\/$/;
const pages: readonly {
  readonly label: MessageId;
  readonly permission: Permission;
  readonly to: string;
}[] = [
  { label: "setting_general", permission: "settings", to: "/admin/settings" },
  {
    label: "setting_appearance",
    permission: "settings",
    to: "/admin/settings/appearance",
  },
  {
    label: "setting_account",
    permission: "profile",
    to: "/admin/settings/account",
  },
  {
    label: "setting_sign_in",
    permission: "profile",
    to: "/admin/settings/sign-in",
  },
  {
    label: "setting_sso",
    permission: "security",
    to: "/admin/settings/single-sign-on",
  },
  {
    label: "setting_storage",
    permission: "settings",
    to: "/admin/settings/storage",
  },
  {
    label: "setting_metrics",
    permission: "settings",
    to: "/admin/settings/metrics",
  },
  {
    label: "setting_locations",
    permission: "settings",
    to: "/admin/settings/locations",
  },
  {
    label: "setting_export_import",
    permission: "transfer",
    to: "/admin/settings/export",
  },
  {
    label: "setting_setup_check",
    permission: "settings",
    to: "/admin/settings/setup-check",
  },
];

export function SettingsNav(): ReactNode {
  const { t } = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const allowed = useAllows();
  return (
    <nav
      aria-label={t("setting_title")}
      className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-subtle p-0.5"
    >
      {pages
        .filter((page) => allowed(page.permission))
        .map((page) => {
          const active = pathname.replace(trailingSlash, "") === page.to;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-control shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm transition-colors",
                active
                  ? "bg-segment font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
              key={page.to}
              to={page.to}
            >
              {t(page.label)}
            </Link>
          );
        })}
    </nav>
  );
}
