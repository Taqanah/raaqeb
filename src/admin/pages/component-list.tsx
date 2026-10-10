/**
 * The components list: every component the install reports on,
 * with its status now, the monitors that drive it (or that its status is
 * set by hand), how many status pages show it, and its uptime over 90
 * days beside a bar of its last 30. The name opens
 * the component's page.
 */
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { useOperatorCalendar } from "@/admin/shell/calendar.tsx";
import { ContentText } from "@/admin/shell/content.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { formatNumber, formatUptime } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ComponentListResult } from "@/shared/schemas/component.ts";
import type { OverviewDay, OverviewNotice } from "@/shared/schemas/overview.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/shared/ui/empty.tsx";
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
import { type NoticeKind, UptimeBar } from "@/shared/ui/uptime-bar.tsx";

const newComponentPath = "/admin/components/new";

export function ComponentList({
  result,
}: {
  readonly result: ComponentListResult;
}): ReactNode {
  const { t } = useMessages();
  const add = (
    <Link
      className={buttonVariants()}
      data-slot="add-component"
      to={newComponentPath}
    >
      {t("component_add")}
    </Link>
  );
  // While the list is empty its card holds the one add button, which says what to add.
  const empty = result.ok && result.components.length === 0;
  return (
    <Page action={empty ? undefined : add} title={t("component_list_title")}>
      <ListBody add={add} result={result} />
    </Page>
  );
}

function ListBody({
  add,
  result,
}: {
  readonly add: ReactNode;
  readonly result: ComponentListResult;
}): ReactNode {
  const { locale, t } = useMessages();
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {result.reason === "corrupt" ? (
            <>
              {t("component_corrupt")} <Token>{result.id}</Token>
            </>
          ) : (
            t("component_unavailable")
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (result.components.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("component_empty_title")}</EmptyTitle>
          <EmptyDescription>
            {t("component_empty_description")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{add}</EmptyContent>
      </Empty>
    );
  }
  return (
    <Table data-slot="component-list" framed stacked>
      <TableHeader>
        <TableRow>
          <TableHead>{t("component_column_name")}</TableHead>
          <TableHead>{t("component_column_status")}</TableHead>
          <TableHead>{t("component_column_monitors")}</TableHead>
          <TableHead>{t("component_column_pages")}</TableHead>
          <TableHead colSpan={2}>{t("component_column_uptime")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.components.map(({ component, days, pages, status, uptime }) => (
          <TableRow data-component={component.id} key={component.id}>
            <TableCell>
              <Link
                className={tableRowLink}
                data-slot="component-name"
                params={{ id: component.id }}
                to="/admin/components/$id"
              >
                <ContentText content={component.name} />
              </Link>
            </TableCell>
            <TableCell>
              <StatusLevelBadge level={status} slot="component-status" />
            </TableCell>
            <TableCell className="tabular-nums">
              {component.monitorIds.length === 0 ? (
                <span className="text-muted-foreground text-sm">
                  {t("component_set_by_hand")}
                </span>
              ) : (
                formatNumber(locale, component.monitorIds.length)
              )}
            </TableCell>
            <TableCell className="tabular-nums">
              {formatNumber(locale, pages)}
            </TableCell>
            <TableCell className="tabular-nums" data-slot="component-uptime">
              {uptime ? (
                formatUptime(locale, uptime)
              ) : (
                <span className="text-muted-foreground text-sm">
                  {t("component_no_data")}
                </span>
              )}
            </TableCell>
            <TableCell className="w-full ps-0">
              <ComponentBar days={days} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The component's last 30 days: compact, no caption, the card on tap; a screen under lg keeps the figure alone. */
function ComponentBar({
  days,
}: {
  readonly days: readonly OverviewDay[];
}): ReactNode {
  const calendar = useOperatorCalendar();
  const notice = useCallback(
    (kind: NoticeKind, each: OverviewNotice) =>
      kind === "incidents" ? (
        <Link
          className="underline-offset-4 hover:underline"
          params={{ id: each.id }}
          to="/admin/incidents/$id"
        >
          <ContentText content={each.title} />
        </Link>
      ) : (
        <Link
          className="underline-offset-4 hover:underline"
          params={{ id: each.id }}
          to="/admin/maintenance/$id"
        >
          <ContentText content={each.title} />
        </Link>
      ),
    []
  );
  return (
    // Over the name's link, which is stretched across the row, so a day's tap opens its card.
    <div className="relative min-w-48 max-lg:hidden" data-slot="component-bar">
      <UptimeBar
        calendar={calendar}
        caption={false}
        // Thirty days from 12rem: each day at least about 4.5px wide, at most 8px, so a wide row keeps them slim.
        className="justify-center [&>button]:h-8 [&>button]:max-w-2"
        days={days}
        notice={notice}
        percentages={false}
      />
    </div>
  );
}
