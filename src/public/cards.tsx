/**
 * What sits above a status page's components: an open incident as a row of
 * the status card, with its latest update and one line of its impact,
 * stage, time and the components it touches on this page; a maintenance window in progress or
 * scheduled, with its times and components. Their text is the operator's,
 * in the language it was written, each paragraph in its own direction.
 * A card's title opens its own view: the incident's full
 * timeline, the window's page.
 */
import type { ReactNode } from "react";
import { intlLocale } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { Content } from "@/shared/schemas/content.ts";
import type { ImpactLevel, OpenStage } from "@/shared/schemas/incident.ts";
import type {
  OverviewIncident,
  OverviewMaintenance,
  PublicView,
} from "@/shared/schemas/overview.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { Badge, type BadgeProps } from "@/shared/ui/badge.tsx";
import { Card } from "@/shared/ui/card.tsx";
import { StatusLevelIcon } from "@/shared/ui/status-level.tsx";
import { quietLink, ViewLink } from "./link.tsx";
import { Prose, useContent } from "./prose.tsx";
import { type TimeContext, When } from "./when.tsx";

const impactWords: Readonly<Record<ImpactLevel, MessageId>> = {
  critical: "incident_impact_critical",
  major: "incident_impact_major",
  minor: "incident_impact_minor",
  none: "incident_impact_none",
};

/** An impact takes the colour of the status it suggests, as in the admin. */
const impactVariants: Readonly<
  Record<ImpactLevel, NonNullable<BadgeProps["variant"]>>
> = {
  critical: "down",
  major: "partial",
  minor: "degraded",
  none: "secondary",
};

const stageWords: Readonly<Record<OpenStage, MessageId>> = {
  identified: "incident_stage_identified",
  investigating: "incident_stage_investigating",
  monitoring: "incident_stage_monitoring",
};

const blankLine = /\n\s*\n/;

/** Plain text in paragraphs, each finding its own direction. */
export function Paragraphs({
  content,
}: {
  readonly content: Content;
}): ReactNode {
  const { lang, text } = useContent()(content);
  return text
    .split(blankLine)
    .filter((paragraph) => paragraph.trim() !== "")
    .map((paragraph, place) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the paragraphs of one text, in order, never reordered; the same paragraph may repeat
      <p className="whitespace-pre-line" dir="auto" key={place} lang={lang}>
        {paragraph}
      </p>
    ));
}

/** The names of the components a card affects, as chips. */
export function Affected({
  ids,
  names,
}: {
  readonly ids: readonly string[];
  readonly names: ReadonlyMap<string, Content>;
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
      <span>{t("public_affected")}</span>
      {ids.map((id) => (
        <Prose
          className="text-foreground"
          content={names.get(id)}
          data-slot="card-component"
          key={id}
        />
      ))}
    </div>
  );
}

/** An open incident as a row of the status card: its title, its latest update, then one line of its impact, stage, when it was last updated and what it touches. */
export function IncidentRow({
  incident,
  level,
  names,
  time,
  view,
}: {
  readonly incident: OverviewIncident;
  /** The page's level, whose icon leads the row as it leads the card. */
  readonly level: StatusLevel;
  readonly names: ReadonlyMap<string, Content>;
  readonly time: TimeContext;
  readonly view: PublicView;
}): ReactNode {
  const { locale, t } = useMessages();
  const shown = useContent();
  const touched = new Intl.ListFormat(intlLocale(locale)).format(
    incident.components.map((id) => shown(names.get(id)).text)
  );
  return (
    <article
      className="flex gap-3 border-inherit border-t bg-card px-4 py-4"
      data-incident={incident.id}
      data-slot="incident-card"
    >
      <StatusLevelIcon className="mt-0.5" level={level} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className="font-medium text-base">
          <ViewLink
            className={quietLink}
            slot="incident-link"
            suffix={`/incidents/${encodeURIComponent(incident.id)}`}
            view={view}
          >
            <Prose content={incident.title} />
          </ViewLink>
        </h2>
        <div className="flex flex-col gap-1.5 text-sm">
          <Paragraphs content={incident.update.message} />
        </div>
        <p
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs"
          data-slot="incident-meta"
        >
          <Badge
            data-impact={incident.impact}
            data-slot="incident-impact"
            variant={impactVariants[incident.impact]}
          >
            {t("public_impact", { impact: t(impactWords[incident.impact]) })}
          </Badge>
          <span data-slot="incident-stage" data-stage={incident.stage}>
            {t(stageWords[incident.stage])}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {t("public_latest_update")}{" "}
            <When at={incident.update.at} relative time={time} />
          </span>
          {incident.components.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("public_affects", { components: touched })}</span>
            </>
          ) : null}
        </p>
      </div>
    </article>
  );
}

const windowWords: Readonly<Record<OverviewMaintenance["stage"], MessageId>> = {
  in_progress: "maintenance_stage_in_progress",
  scheduled: "maintenance_stage_scheduled",
};

export function MaintenanceCard({
  names,
  time,
  view,
  window,
}: {
  readonly names: ReadonlyMap<string, Content>;
  readonly time: TimeContext;
  readonly view: PublicView;
  readonly window: OverviewMaintenance;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card
      as="article"
      className="px-(--card-spacing)"
      data-slot="maintenance-card"
      data-window={window.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          data-slot="window-stage"
          data-stage={window.stage}
          variant={window.stage === "in_progress" ? "maintenance" : "secondary"}
        >
          {t(windowWords[window.stage])}
        </Badge>
      </div>
      <h2 className="font-medium text-base">
        <ViewLink
          className={quietLink}
          slot="maintenance-link"
          suffix={`/maintenance/${encodeURIComponent(window.id)}`}
          view={view}
        >
          <Prose content={window.title} />
        </ViewLink>
      </h2>
      <div className="flex flex-col gap-1.5 text-sm">
        <Paragraphs content={window.message} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
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
          {t("public_maintenance_ends")}
        </dt>
        <dd>
          <When at={window.endsAt} relative time={time} />
        </dd>
      </dl>
      <Affected ids={window.components} names={names} />
    </Card>
  );
}
