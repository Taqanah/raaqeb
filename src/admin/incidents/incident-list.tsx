/**
 * The incidents list: open incidents first, then resolved ones,
 * each newest first, with the impact level, the stage, the affected
 * components, when it started and how long it lasted or has been open.
 * The title opens the incident's page.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ContentText } from "@/admin/shell/content.tsx";
import { Page } from "@/admin/shell/page.tsx";
import { formatDuration, type TimeOptions } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  IncidentListItem,
  IncidentListResult,
} from "@/shared/schemas/incident.ts";
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
import { ImpactBadge, StageBadge, When } from "./incident-words.tsx";

const newIncidentPath = "/admin/incidents/new";

export function IncidentList({
  clock,
  result,
}: {
  readonly clock: TimeOptions;
  readonly result: IncidentListResult;
}): ReactNode {
  const { t } = useMessages();
  const add = (
    <Link
      className={buttonVariants()}
      data-slot="add-incident"
      to={newIncidentPath}
    >
      {t("incident_add")}
    </Link>
  );
  // While the list is empty its card holds the one add button, which says what to add.
  const empty = result.ok && result.list.incidents.length === 0;
  return (
    <Page action={empty ? undefined : add} title={t("incident_list_title")}>
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
  readonly result: IncidentListResult;
}): ReactNode {
  const { t } = useMessages();
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {result.reason === "corrupt" ? (
            <>
              {t("incident_corrupt")} <Token>{result.id}</Token>
            </>
          ) : (
            t("incident_unavailable")
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (result.list.incidents.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("incident_empty_title")}</EmptyTitle>
          <EmptyDescription>{t("incident_empty_description")}</EmptyDescription>
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
                {t("incident_needs_component")}
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
    <Table data-slot="incident-list" framed stacked>
      <TableHeader>
        <TableRow>
          <TableHead>{t("incident_column_title")}</TableHead>
          <TableHead>{t("incident_column_impact")}</TableHead>
          <TableHead>{t("incident_column_stage")}</TableHead>
          <TableHead>{t("incident_column_components")}</TableHead>
          <TableHead>{t("incident_column_started")}</TableHead>
          <TableHead>{t("incident_column_duration")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.list.incidents.map((item) => (
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
  readonly item: IncidentListItem;
  readonly now: number;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <TableRow data-incident={item.id} data-stage={item.stage}>
      <TableCell>
        <Link
          className={tableRowLink}
          data-slot="incident-title"
          params={{ id: item.id }}
          to="/admin/incidents/$id"
        >
          <ContentText content={item.title} />
        </Link>
      </TableCell>
      <TableCell>
        <ImpactBadge impact={item.impact} />
      </TableCell>
      <TableCell>
        <StageBadge stage={item.stage} />
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1" data-slot="incident-components">
          {item.components.map((component) => (
            <Badge key={component.id} variant="outline">
              <ContentText content={component.name} />
            </Badge>
          ))}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <When at={item.createdAt} clock={clock} now={now} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm tabular-nums">
        {item.resolvedAt === undefined
          ? t("incident_open_for", {
              duration: formatDuration(locale, now - item.createdAt),
            })
          : t("incident_lasted", {
              duration: formatDuration(
                locale,
                item.resolvedAt - item.createdAt
              ),
            })}
      </TableCell>
    </TableRow>
  );
}
