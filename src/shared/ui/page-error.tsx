/**
 * What a page whose read or render failed shows: a line saying so in
 * the catalog's words and "try again", which reads the page again. The
 * error's own text never reaches the reader. The admin frames it in its
 * page; every other route shows it alone on the document.
 */
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { useMessages } from "@/shared/i18n/react.tsx";
import { Button } from "./button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "./empty.tsx";
import { RefreshIcon } from "./icons.tsx";

/** The line and the button; `titled` adds the title where no frame's title row says it. */
export function ErrorNotice({
  titled,
}: {
  readonly titled: boolean;
}): ReactNode {
  const { t } = useMessages();
  const router = useRouter();
  // Invalidating reads every match again and resets the boundary that shows this.
  const retry = useCallback(() => {
    router.invalidate().catch(() => undefined);
  }, [router]);
  return (
    <Empty data-slot="page-error">
      <EmptyHeader>
        {titled ? <EmptyTitle>{t("app_error_title")}</EmptyTitle> : null}
        <EmptyDescription>{t("app_error_description")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button name="retry" onClick={retry} variant="outline">
          <RefreshIcon />
          {t("app_try_again")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** The notice alone on the document, centred, where nothing frames it. */
export function DocumentError(): ReactNode {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl items-center px-6">
      <ErrorNotice titled />
    </main>
  );
}
