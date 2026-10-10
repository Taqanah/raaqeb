/**
 * The status pages list: every page with its status level now,
 * the path it is served at, the default page's badge, its custom domain,
 * its page language and how many components it shows. The title opens the
 * page's editor.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ContentText } from "@/admin/shell/content.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { formatNumber } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { PageListResult } from "@/shared/schemas/page.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Badge } from "@/shared/ui/badge.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";
import { localeNames } from "@/shared/ui/locale-switcher.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  tableRowLink,
} from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";

const newPagePath = "/admin/pages/new";

export function PageList({
  result,
}: {
  readonly result: PageListResult;
}): ReactNode {
  const { t } = useMessages();
  const add = (
    <Link className={buttonVariants()} data-slot="add-page" to={newPagePath}>
      {t("page_add")}
    </Link>
  );
  // While the list is empty its card holds the one add button, which says what to add.
  const empty = result.ok && result.pages.length === 0;
  return (
    <Page action={empty ? undefined : add} title={t("page_list_title")}>
      <ListBody add={add} result={result} />
    </Page>
  );
}

function ListBody({
  add,
  result,
}: {
  readonly add: ReactNode;
  readonly result: PageListResult;
}): ReactNode {
  const { locale, t } = useMessages();
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {result.reason === "corrupt" ? (
            <>
              {t("page_corrupt")} <Token>{result.id}</Token>
            </>
          ) : (
            t("page_unavailable")
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (result.pages.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("page_empty_title")}</EmptyTitle>
          <EmptyDescription>{t("page_empty_description")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{add}</EmptyContent>
      </Empty>
    );
  }
  return (
    <Table data-slot="page-list" framed stacked>
      <TableHeader>
        <TableRow>
          <TableHead>{t("page_column_title")}</TableHead>
          <TableHead>{t("page_column_level")}</TableHead>
          <TableHead>{t("page_column_path")}</TableHead>
          <TableHead>{t("page_column_language")}</TableHead>
          <TableHead>{t("page_column_components")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.pages.map(({ components, level, page }) => (
          <TableRow data-page={page.id} key={page.id}>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  className={tableRowLink}
                  data-slot="page-title"
                  params={{ id: page.id }}
                  to="/admin/pages/$id"
                >
                  <ContentText content={page.title} />
                </Link>
                {page.isDefault ? (
                  <Badge data-slot="page-default" variant="secondary">
                    {t("page_default_badge")}
                  </Badge>
                ) : null}
                {page.published ? null : (
                  <Badge data-slot="page-unpublished" variant="outline">
                    {t("page_unpublished_badge")}
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell>
              <StatusLevelBadge level={level} slot="page-level" />
            </TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <Token data-slot="page-path">{`/status/${page.slug}`}</Token>
                {page.customDomain ? (
                  <Token data-slot="page-domain">{page.customDomain}</Token>
                ) : null}
              </div>
            </TableCell>
            <TableCell>{localeNames[page.locale]}</TableCell>
            <TableCell className="tabular-nums">
              {formatNumber(locale, components)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
