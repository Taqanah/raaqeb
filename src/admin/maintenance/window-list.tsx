/**
 * The maintenance list: windows in
 * progress first, then scheduled ones soonest first, then completed ones
 * newest first, each with its stage, its affected components, its start,
 * its end and its length. The title opens the window's page.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { When } from "@/admin/incidents/incident-words.tsx";
import { ContentText } from "@/admin/shell/content.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { formatDuration, type TimeOptions } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MaintenanceListItem,
  MaintenanceListResult,
} from "@/shared/schemas/maintenance.ts";
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
import { StageBadge } from "./window-words.tsx";

const newWindowPath = "/admin/maintenance/new";

export function WindowList({
  clock,
  result,
}: {
  readonly clock: TimeOptions;
  readonly result: MaintenanceListResult;
}): ReactNode {
  const { t } = useMessages();
  const add = (
    <Link
      className={buttonVariants()}
      data-slot="add-window"
      to={newWindowPath}
    >
      {t("maintenance_add")}
    </Link>
  );
  // While the list is empty its card holds the one add button, which says what to add.
  const empty = result.ok && result.list.windows.length === 0;
  return (
    <Page action={empty ? undefined : add} title={t("maintenance_list_title")}>
      <ListBody add={add} clock={clock} result={result} />
    </Page>
  );
}

function ListBody({
  add,
  clock,
  result,
}: {
  readonly add: ReactNode;
  readonly clock: TimeOptions;
  readonly result: MaintenanceListResult;
}): ReactNode {
  const { t } = useMessages();
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {result.reason === "corrupt" ? (
            <>
              {t("maintenance_corrupt")} <Token>{result.id}</Token>
            </>
          ) : (
            t("maintenance_unavailable")
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (result.list.windows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("maintenance_empty_title")}</EmptyTitle>
          <EmptyDescription>
            {t("maintenance_empty_description")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {result.list.anyComponent ? (
            add
          ) : (
            <>
              <p
                className="text-muted-foreground text-sm"
                data-slot="needs-component"
              >
                {t("maintenance_needs_component")}
              </p>
              <Link className={buttonVariants()} to="/admin/components/new">
                {t("component_add")}
              </Link>
            </>
          )}
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Table data-slot="window-list" framed stacked>
      <TableHeader>
        <TableRow>
          <TableHead>{t("maintenance_column_title")}</TableHead>
          <TableHead>{t("maintenance_column_stage")}</TableHead>
          <TableHead>{t("maintenance_column_components")}</TableHead>
          <TableHead>{t("maintenance_column_starts")}</TableHead>
          <TableHead>{t("maintenance_column_ends")}</TableHead>
          <TableHead>{t("maintenance_column_duration")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.list.windows.map((item) => (
          <Row clock={clock} item={item} key={item.id} now={result.list.now} />
        ))}
      </TableBody>
    </Table>
  );
}

function Row({
  clock,
  item,
  now,
}: {
  readonly clock: TimeOptions;
  readonly item: MaintenanceListItem;
  readonly now: number;
}): ReactNode {
  const { locale } = useMessages();
  return (
    <TableRow data-stage={item.stage} data-window={item.id}>
      {/* A long title wraps rather than widening the table past the page (the screenshot run). */}
      <TableCell className="min-w-48 whitespace-normal">
        <Link
          className={tableRowLink}
          data-slot="window-title"
          params={{ id: item.id }}
          to="/admin/maintenance/$id"
        >
          <ContentText content={item.title} />
        </Link>
      </TableCell>
      <TableCell>
        <StageBadge stage={item.stage} />
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1" data-slot="window-components">
          {item.components.map((component) => (
            <Badge key={component.id} variant="outline">
              <ContentText content={component.name} />
            </Badge>
          ))}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <When at={item.startsAt} clock={clock} now={now} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <When at={item.endsAt} clock={clock} now={now} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm tabular-nums">
        {formatDuration(locale, item.endsAt - item.startsAt)}
      </TableCell>
    </TableRow>
  );
}
