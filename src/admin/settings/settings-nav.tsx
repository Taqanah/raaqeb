/**
 * The settings area's pages as a row of links under the title: general,
 * appearance, account, sign-in, storage, export and import, and the setup
 * check.
 */
import { Link, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { cn } from "@/shared/ui/cn.ts";

const trailingSlash = /\/$/;
const pages: readonly { readonly label: MessageId; readonly to: string }[] = [
  { label: "setting_general", to: "/admin/settings" },
  { label: "setting_appearance", to: "/admin/settings/appearance" },
  { label: "setting_account", to: "/admin/settings/account" },
  { label: "setting_sign_in", to: "/admin/settings/sign-in" },
  { label: "setting_storage", to: "/admin/settings/storage" },
  { label: "setting_export_import", to: "/admin/settings/export" },
  { label: "setting_setup_check", to: "/admin/settings/setup-check" },
];

export function SettingsNav(): ReactNode {
  const { t } = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <nav
      aria-label={t("setting_title")}
      className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-subtle p-0.5"
    >
      {pages.map((page) => {
        const active = pathname.replace(trailingSlash, "") === page.to;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-control shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-4 focus-visible:ring-ring-soft",
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
