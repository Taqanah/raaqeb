/**
 * A status page's other views:
 * the history of one month with its month navigation, one incident with
 * every update, one maintenance window, and the page's own not-found for an
 * address with nothing on it. Each renders inside the page's frame from its
 * view's JSON document and nothing else. The operator's text keeps the
 * language it was written in, each paragraph in its own direction; times follow the overview's rule.
 */
import type { ReactNode } from "react";
import { formatDuration, formatMonth } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ImpactLevel, IncidentStage } from "@/shared/schemas/incident.ts";
import type { MaintenanceStage } from "@/shared/schemas/maintenance.ts";
import type { PublicView } from "@/shared/schemas/overview.ts";
import type {
  HistoryDocument,
  HistoryEntry,
  IncidentDocument,
  MaintenanceDocument,
  ViewComponent,
  ViewFrame,
} from "@/shared/schemas/views.ts";
import { Badge, type BadgeProps } from "@/shared/ui/badge.tsx";
import { Card } from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { Empty, EmptyDescription } from "@/shared/ui/empty.tsx";
import { ChevronEndIcon } from "@/shared/ui/icons.tsx";
import { Paragraphs } from "./cards.tsx";
import { quietLink, ViewLink } from "./link.tsx";
import { PageFrame, useViewTime } from "./overview.tsx";
import { Prose } from "./prose.tsx";
import { type TimeContext, When } from "./when.tsx";

const impactWords: Readonly<Record<ImpactLevel, MessageId>> = {
  critical: "incident_impact_critical",
  major: "incident_impact_major",
  minor: "incident_impact_minor",
  none: "incident_impact_none",
};

/** An impact takes the colour of the status it suggests, as on the overview's cards. */
const impactVariants: Readonly<
  Record<ImpactLevel, NonNullable<BadgeProps["variant"]>>
> = {
  critical: "down",
  major: "partial",
  minor: "degraded",
  none: "secondary",
};

const stageWords: Readonly<Record<IncidentStage, MessageId>> = {
  identified: "incident_stage_identified",
  investigating: "incident_stage_investigating",
  monitoring: "incident_stage_monitoring",
  resolved: "incident_stage_resolved",
};

const windowWords: Readonly<Record<MaintenanceStage, MessageId>> = {
  completed: "maintenance_stage_completed",
  in_progress: "maintenance_stage_in_progress",
  scheduled: "maintenance_stage_scheduled",
};

/** A stage is neutral until it ends, which is green; a window in progress is maintenance blue, as in the admin. */
const windowVariants: Readonly<
  Record<MaintenanceStage, NonNullable<BadgeProps["variant"]>>
> = {
  completed: "up",
  in_progress: "maintenance",
  scheduled: "secondary",
};

const incidentPath = (id: string) => `/incidents/${encodeURIComponent(id)}`;
const maintenancePath = (id: string) =>
  `/maintenance/${encodeURIComponent(id)}`;

function ImpactBadge({ impact }: { readonly impact: ImpactLevel }): ReactNode {
  const { t } = useMessages();
  return (
    <Badge
      data-impact={impact}
      data-slot="incident-impact"
      variant={impactVariants[impact]}
    >
      {t("public_impact", { impact: t(impactWords[impact]) })}
    </Badge>
  );
}

/** The components an entry affects, as chips. */
function Components({
  components,
}: {
  readonly components: readonly ViewComponent[];
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
      <span>{t("public_affected")}</span>
      {components.map((component) => (
        <Prose
          className="rounded-sm bg-subtle px-1.5 py-0.5 text-foreground"
          content={component.name}
          data-slot="card-component"
          key={component.id}
        />
      ))}
    </div>
  );
}

/** Where the view sits on the page: the overview, then the history, then an incident or a window, each above a link to it. */
function ViewNav({
  current,
  view,
}: {
  readonly current: "history" | "incident" | "maintenance";
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  const here = (words: MessageId) => (
    <li aria-current="page" className="text-foreground">
      {t(words)}
    </li>
  );
  return (
    <nav aria-label={t("public_view_nav")} data-slot="view-nav">
      <ol className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-sm [&>li]:inline-flex [&>li]:items-center">
        <li>
          <ViewLink
            className={quietLink}
            slot="view-overview"
            suffix=""
            view={view}
          >
            {t("public_current_status")}
          </ViewLink>
        </li>
        <Separator />
        {current === "history" ? (
          here("public_history")
        ) : (
          <>
            <li>
              <ViewLink
                className={quietLink}
                slot="view-history"
                suffix="/history"
                view={view}
              >
                {t("public_history")}
              </ViewLink>
            </li>
            <Separator />
            {here(
              current === "incident" ? "public_incident" : "public_maintenance"
            )}
          </>
        )}
      </ol>
    </nav>
  );
}

/** A chevron between two places, toward the reading end. */
function Separator(): ReactNode {
  return (
    <li aria-hidden>
      <ChevronEndIcon className="size-icon-sm" />
    </li>
  );
}

/** A start and how long it lasted. */
function Span({
  end,
  start,
  time,
}: {
  readonly end: string;
  readonly start: string;
  readonly time: TimeContext;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <p className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
      <When at={start} relative time={time} />
      <span>
        {t("public_lasted", {
          duration: formatDuration(locale, Date.parse(end) - Date.parse(start)),
        })}
      </span>
    </p>
  );
}

function Entry({
  entry,
  time,
  view,
}: {
  readonly entry: HistoryEntry;
  readonly time: TimeContext;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  const incident = entry.kind === "incident";
  return (
    <li
      className="flex flex-col gap-2 p-(--card-spacing)"
      data-entry={entry.id}
      data-kind={entry.kind}
      data-slot="history-entry"
    >
      <div className="flex flex-wrap items-center gap-2">
        {incident ? (
          <ImpactBadge impact={entry.impact} />
        ) : (
          <Badge data-slot="history-maintenance" variant="maintenance">
            {t("public_maintenance")}
          </Badge>
        )}
      </div>
      <h3 className="font-medium text-sm">
        <ViewLink
          className={quietLink}
          slot="history-link"
          suffix={incident ? incidentPath(entry.id) : maintenancePath(entry.id)}
          view={view}
        >
          <Prose content={entry.title} />
        </ViewLink>
      </h3>
      {incident ? (
        <Span end={entry.resolvedAt} start={entry.startedAt} time={time} />
      ) : (
        <Span end={entry.endsAt} start={entry.startsAt} time={time} />
      )}
      <Components components={entry.components} />
    </li>
  );
}

export function History({
  document,
  view,
}: {
  readonly document: HistoryDocument;
  readonly view: PublicView;
}): ReactNode {
  const { locale, t } = useMessages();
  const time = useViewTime(document);
  // Earlier points back toward the start side, later on toward the end.
  const month = (step: string, slot: string, words: MessageId) => (
    <ViewLink
      className={cn(quietLink, wayLink)}
      slot={slot}
      suffix={`/history/${step}`}
      view={view}
    >
      {slot === "history-previous" ? <BackChevron /> : null}
      {t(words)}
      {slot === "history-next" ? (
        <ChevronEndIcon className="size-icon-sm" />
      ) : null}
    </ViewLink>
  );
  return (
    <PageFrame
      page={document.page}
      suffix={`/history/${document.month}`}
      view={view}
    >
      <ViewNav current="history" view={view} />
      <section
        className="flex flex-col gap-4"
        data-month={document.month}
        data-slot="history"
      >
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-lg">{t("public_history")}</h2>
          <p
            className="text-muted-foreground text-sm"
            data-slot="history-month"
          >
            {formatMonth(locale, document.month, document.calendar)}
          </p>
        </div>
        {document.entries.length === 0 ? (
          <Empty>
            <EmptyDescription>{t("public_history_empty")}</EmptyDescription>
          </Empty>
        ) : (
          <Card className="py-0">
            <ul className="divide-y divide-border">
              {document.entries.map((entry) => (
                <Entry entry={entry} key={entry.id} time={time} view={view} />
              ))}
            </ul>
          </Card>
        )}
        <nav className="flex items-center justify-between gap-4 text-sm">
          <span>
            {document.previous
              ? month(
                  document.previous,
                  "history-previous",
                  "public_history_previous"
                )
              : null}
          </span>
          <span>
            {document.next
              ? month(document.next, "history-next", "public_history_next")
              : null}
          </span>
        </nav>
      </section>
    </PageFrame>
  );
}

export function IncidentView({
  document,
  view,
}: {
  readonly document: IncidentDocument;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  const time = useViewTime(document);
  const { incident } = document;
  return (
    <PageFrame
      page={document.page}
      suffix={incidentPath(incident.id)}
      view={view}
    >
      <ViewNav current="incident" view={view} />
      <article
        className="flex flex-col gap-4"
        data-incident={incident.id}
        data-slot="incident-view"
      >
        <Card className="gap-3 px-(--card-spacing)">
          <div className="flex flex-wrap items-center gap-2">
            <ImpactBadge impact={incident.impact} />
            <Badge
              data-slot="incident-stage"
              data-stage={incident.stage}
              variant={incident.stage === "resolved" ? "up" : "secondary"}
            >
              {t(stageWords[incident.stage])}
            </Badge>
          </div>
          <h2 className="font-semibold text-lg">
            <Prose content={incident.title} />
          </h2>
          {/* How long it lasted once it ended, which only the history card said before. */}
          <dl className={times}>
            <dt className="text-muted-foreground">{t("public_started")}</dt>
            <dd data-slot="incident-started">
              <When at={incident.startedAt} relative time={time} />
            </dd>
            {incident.resolvedAt ? (
              <>
                <dt className="text-muted-foreground">
                  {t("public_resolved")}
                </dt>
                <dd>
                  <When at={incident.resolvedAt} relative time={time} />
                </dd>
                <Duration
                  end={incident.resolvedAt}
                  start={incident.startedAt}
                />
              </>
            ) : null}
          </dl>
          <Components components={incident.components} />
        </Card>
        <Card as="section" className="px-(--card-spacing)">
          <h3 className="font-medium text-base">{t("public_updates")}</h3>
          <ol className="flex flex-col gap-4 border-border border-s-2 ps-4">
            {incident.updates.map((update) => (
              <li
                className="flex flex-col gap-1.5 text-sm"
                data-slot="incident-update"
                data-stage={update.stage}
                key={update.at}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">
                    {t(stageWords[update.stage])}
                  </span>
                  <span className="text-muted-foreground">
                    <When at={update.at} relative time={time} />
                  </span>
                </div>
                <Paragraphs content={update.message} />
              </li>
            ))}
          </ol>
        </Card>
      </article>
    </PageFrame>
  );
}

export function MaintenanceView({
  document,
  view,
}: {
  readonly document: MaintenanceDocument;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  const time = useViewTime(document);
  const { window } = document;
  return (
    <PageFrame
      page={document.page}
      suffix={maintenancePath(window.id)}
      view={view}
    >
      <ViewNav current="maintenance" view={view} />
      <Card
        as="article"
        className="gap-3 px-(--card-spacing)"
        data-slot="maintenance-view"
        data-window={window.id}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            data-slot="window-stage"
            data-stage={window.stage}
            variant={windowVariants[window.stage]}
          >
            {t(windowWords[window.stage])}
          </Badge>
        </div>
        <h2 className="font-semibold text-lg">
          <Prose content={window.title} />
        </h2>
        <div className="flex flex-col gap-1.5 text-sm">
          <Paragraphs content={window.message} />
        </div>
        <dl className={times}>
          <dt className="text-muted-foreground">
            {t(
              window.stage === "scheduled"
                ? "public_maintenance_starts"
                : "public_maintenance_started"
            )}
          </dt>
          <dd>
            <When at={window.startsAt} relative time={time} />
          </dd>
          <dt className="text-muted-foreground">
            {t(
              window.stage === "completed"
                ? "public_maintenance_ended"
                : "public_maintenance_ends"
            )}
          </dt>
          <dd>
            <When at={window.endsAt} relative time={time} />
          </dd>
          {window.stage === "completed" ? (
            <Duration end={window.endsAt} start={window.startsAt} />
          ) : null}
        </dl>
        <Components components={window.components} />
      </Card>
    </PageFrame>
  );
}

/** An address on a page with nothing at it: the page's frame, what happened, and the way back to its overview. */
export function PageMissing({
  frame,
  suffix,
  view,
}: {
  readonly frame: ViewFrame;
  /** The address's own part past the page's plain address, so the language switch keeps it. */
  readonly suffix: string;
  readonly view: PublicView;
}): ReactNode {
  const { t } = useMessages();
  return (
    <PageFrame page={frame.page} still suffix={suffix} view={view}>
      <Empty data-slot="view-missing">
        <p className="text-sm">{t("public_not_found")}</p>
        <ViewLink
          className={quietLink}
          reload
          slot="view-overview"
          suffix=""
          view={view}
        >
          {t("public_current_status")}
        </ViewLink>
      </Empty>
    </PageFrame>
  );
}

/** The not-found where no page is known to frame it: the same words, in the document's language. */
export function PlainMissing(): ReactNode {
  const { t } = useMessages();
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-3xl items-center justify-center px-5 text-center text-muted-foreground text-sm"
      data-slot="view-missing"
    >
      {t("public_not_found")}
    </main>
  );
}

/** A view whose document could not be read on its first load: the database or the network did not answer. */
export function ViewUnavailable(): ReactNode {
  const { t } = useMessages();
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-3xl items-center justify-center px-5 text-center text-muted-foreground text-sm"
      data-slot="view-unavailable"
    >
      {t("public_unavailable")}
    </main>
  );
}

/** The labelled times of an incident or a window. */
const times = "grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm";

/** How long it lasted, as a row of the times. */
function Duration({
  end,
  start,
}: {
  readonly end: string;
  readonly start: string;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <>
      <dt className="text-muted-foreground">{t("public_duration")}</dt>
      <dd data-slot="view-duration">
        {formatDuration(locale, Date.parse(end) - Date.parse(start))}
      </dd>
    </>
  );
}

/** A link that moves between views: a chevron beside it marks it as a way, not text. */
const wayLink = "inline-flex items-center gap-1";

/** A chevron toward the start side, for a link that goes back. */
function BackChevron(): ReactNode {
  return <ChevronEndIcon className="size-icon-sm rotate-180" />;
}
