/**
 * The release banner: one line above the page when the daily check
 * found a release newer than the running build, linking to its notes. Never
 * updates anything.
 */
import type { ReactNode } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Release } from "@/shared/schemas/release.ts";
import { Alert, AlertTitle } from "@/shared/ui/alert.tsx";
import { Token } from "@/shared/ui/token.tsx";

export function ReleaseBanner({ release }: { release: Release }): ReactNode {
  const { t } = useMessages();
  return (
    <Alert
      className="rounded-none border-x-0 border-t-0"
      data-slot="release-banner"
    >
      <AlertTitle className="flex flex-wrap items-center gap-2">
        <span>
          {t("app_release_banner")} <Token>{release.version}</Token>
        </span>
        <a href={release.url} rel="noreferrer" target="_blank">
          {t("app_release_notes")}
        </a>
      </AlertTitle>
    </Alert>
  );
}
