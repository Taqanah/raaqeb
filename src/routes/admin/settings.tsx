import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { SettingsNav } from "@/admin/settings/settings-nav.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";

// The settings area: the title, the row of its pages, and the
// page itself below.
export const Route = createFileRoute("/admin/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useMessages();
  return (
    <Page title={t("setting_title")}>
      <SettingsNav />
      {/* A settings page whose skeleton has not loaded yet suspends below the row of settings pages. */}
      <Suspense>
        <Outlet />
      </Suspense>
    </Page>
  );
}
