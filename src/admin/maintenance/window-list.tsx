/**
 * The maintenance list: windows in
 * progress first, then scheduled ones soonest first, then completed ones
 * newest first, each with its stage, its affected components, its start,
 * its end and its length. The title opens the window's page; an
 * occurrence carries the series' mark. Above them the maintenance series,
 * each with how it repeats and when its next occurrence starts, the title
 * opening the series' page.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { When } from "@/admin/incidents/incident-words.tsx";
import { ContentList, ContentText } from "@/admin/shell/content.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { formatDuration, type TimeOptions } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MaintenanceList,
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
import { recurrenceWords, StageBadge } from "./window-words.tsx";

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
  const empty =
    result.ok &&
    result.list.windows.length === 0 &&
    result.list.series.length === 0;
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
  if (result.list.windows.length === 0 && result.list.series.length === 0) {
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
  const windows = (
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
  if (result.list.series.length === 0) {
    return windows;
  }
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-base">
          {t("maintenance_series_list_title")}
        </h2>
        <SeriesTable clock={clock} list={result.list} />
      </section>
      {result.list.windows.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold text-base">
            {t("maintenance_windows_list_title")}
          </h2>
          {windows}
        </section>
      )}
    </div>
  );
}

function SeriesTable({
  clock,
  list,
}: {
  readonly clock: TimeOptions;
  readonly list: MaintenanceList;
}): ReactNode {
  const messages = useMessages();
  const { t } = messages;
  return (
    <Table data-slot="series-list" framed stacked>
      <TableHeader>
        <TableRow>
          <TableHead>{t("maintenance_column_title")}</TableHead>
          <TableHead>{t("maintenance_series_column_repeats")}</TableHead>
          <TableHead>{t("maintenance_column_components")}</TableHead>
          <TableHead>{t("maintenance_series_column_next")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.series.map((item) => (
          <TableRow data-series={item.id} key={item.id}>
            <TableCell className="min-w-48 whitespace-normal">
              <Link
                className={tableRowLink}
                data-slot="series-title"
                params={{ id: item.id }}
                to="/admin/maintenance/series/$id"
              >
                <ContentText content={item.title} />
              </Link>
            </TableCell>
            <TableCell
              className="whitespace-normal text-sm"
              label={t("maintenance_series_column_repeats")}
            >
              {recurrenceWords(messages, item.recurrence, clock.clock)}
            </TableCell>
            <TableCell label={t("maintenance_column_components")}>
              <span className="text-sm">
                <ContentList
                  contents={item.components.map((component) => component.name)}
                />
              </span>
            </TableCell>
            <TableCell
              className="whitespace-nowrap"
              label={t("maintenance_series_column_next")}
            >
              <When at={item.next} clock={clock} now={list.now} />
            </TableCell>
          </TableRow>
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
  const { locale, t } = useMessages();
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
        <span className="flex flex-wrap items-center gap-2">
          <StageBadge stage={item.stage} />
          {item.seriesId === undefined ? null : (
            <Badge data-slot="window-occurrence" variant="outline">
              {t("maintenance_occurrence_mark")}
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell label={t("maintenance_column_components")}>
        <span className="text-sm" data-slot="window-components">
          <ContentList
            contents={item.components.map((component) => component.name)}
          />
        </span>
      </TableCell>
      <TableCell
        className="whitespace-nowrap"
        label={t("maintenance_column_starts")}
      >
        <When at={item.startsAt} clock={clock} now={now} />
      </TableCell>
      <TableCell
        className="whitespace-nowrap"
        label={t("maintenance_column_ends")}
      >
        <When at={item.endsAt} clock={clock} now={now} />
      </TableCell>
      <TableCell
        className="whitespace-nowrap text-sm tabular-nums"
        label={t("maintenance_column_duration")}
      >
        {formatDuration(locale, item.endsAt - item.startsAt)}
      </TableCell>
    </TableRow>
  );
}
