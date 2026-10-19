/**
 * A maintenance series' page (CONTEXT.md "Maintenance series",
 * "Occurrence"): its recurrence, length, zone and next occurrence beside
 * the end action, its scheduled occurrences, each opening its own window's
 * page where it is changed or cancelled alone, and the series' own form.
 * Saving the form replaces the scheduled occurrences, which the form says
 * above its fields. Every write reads the page again.
 */
import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { When } from "@/admin/incidents/incident-words.tsx";
import { zoneOption } from "@/admin/settings/zones.ts";
import { useContentIn, useInstallLanguage } from "@/admin/shell/content.tsx";
import { formWidth, Page } from "@/admin/shell/page.tsx";
import { useRefusedFields } from "@/admin/shell/refused-fields.ts";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { formatDuration, type TimeOptions } from "@/shared/i18n/format.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  MaintenanceDeleteResult,
  MaintenanceRefusal,
  MaintenanceSeriesPage,
  MaintenanceSeriesSaveResult,
  SeriesInput,
} from "@/shared/schemas/maintenance.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { RecurrenceCard, RepeatChoice } from "./recurrence-card.tsx";
import {
  type RecurrenceDraft,
  type SeriesTextDraft,
  seriesDraftOf,
  seriesInputOf,
} from "./series-draft.ts";
import type { WindowFieldErrors } from "./window-draft.ts";
import {
  ComponentsCard,
  Confirmed,
  chosenOf,
  DetailsCard,
  outcomeOf,
} from "./window-form.tsx";
import { recurrenceWords, refusalWords, StageBadge } from "./window-words.tsx";

export interface SeriesPageProps {
  readonly clock: TimeOptions;
  readonly edit: (
    input: SeriesInput
  ) => Promise<MaintenanceSeriesSaveResult | undefined>;
  readonly end: () => Promise<MaintenanceDeleteResult | undefined>;
  /** Called after every write, so the page reads itself again. */
  readonly onChanged: () => void;
  /** Called once the series ended. */
  readonly onEnded: () => void;
  readonly page: MaintenanceSeriesPage;
}

export function SeriesPage({
  clock,
  edit,
  end,
  onChanged,
  onEnded,
  page,
}: SeriesPageProps): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  return (
    <Page
      parent={{ label: t("maintenance_list_title"), to: "/admin/maintenance" }}
      title={text(page.series.title)}
    >
      <div className={cn("flex flex-col gap-6", formWidth)}>
        <Summary
          action={
            <Confirmed
              action={end}
              confirm="confirm-end-series"
              description="maintenance_series_end_description"
              destructive
              label="maintenance_series_end"
              onChanged={onChanged}
              onDone={onEnded}
              slot="end-series"
              title="maintenance_series_end_title"
            />
          }
          clock={clock}
          page={page}
        />
        <Occurrences clock={clock} page={page} />
        <SeriesForm
          clock={clock}
          edit={edit}
          onChanged={onChanged}
          page={page}
        />
      </div>
    </Page>
  );
}

/** The series at a glance: how it repeats, how long, in which zone, and when the next occurrence starts. */
function Summary({
  action,
  clock,
  page,
}: {
  readonly action: ReactNode;
  readonly clock: TimeOptions;
  readonly page: MaintenanceSeriesPage;
}): ReactNode {
  const messages = useMessages();
  const { locale, t } = messages;
  const { recurrence } = page.series;
  const [scheduled] = page.occurrences.filter(
    (each) => each.stage === "scheduled"
  );
  return (
    <Card data-slot="series-summary">
      <CardContent className="flex flex-wrap items-start justify-between gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">
            {t("maintenance_series_column_repeats")}
          </dt>
          <dd data-slot="series-recurrence">
            {recurrenceWords(messages, recurrence, clock.clock)}
          </dd>
          <dt className="text-muted-foreground">
            {t("maintenance_column_duration")}
          </dt>
          <dd>{formatDuration(locale, recurrence.minutes * 60_000)}</dd>
          <dt className="text-muted-foreground">
            {t("maintenance_times_zone")}
          </dt>
          <dd>
            {/* Localized words, not a machine token: isolated, in the text face. */}
            <bdi data-zone={recurrence.timeZone}>
              {zoneOption(recurrence.timeZone, locale, page.now).label}
            </bdi>
          </dd>
          <dt className="text-muted-foreground">
            {t("maintenance_series_column_next")}
          </dt>
          <dd>
            <When
              at={scheduled?.startsAt ?? page.next}
              clock={clock}
              now={page.now}
            />
          </dd>
        </dl>
        {action}
      </CardContent>
    </Card>
  );
}

/** The occurrences in progress and scheduled, each opening its window's page. */
function Occurrences({
  clock,
  page,
}: {
  readonly clock: TimeOptions;
  readonly page: MaintenanceSeriesPage;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("maintenance_series_occurrences")}</CardTitle>
        <CardDescription>
          {t("maintenance_series_occurrences_hint")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {page.occurrences.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("maintenance_series_occurrences_none")}
          </p>
        ) : (
          <ul className="flex flex-col" data-slot="series-occurrences">
            {page.occurrences.map((occurrence) => (
              <li
                className="flex min-h-control flex-wrap items-center justify-between gap-3 border-border border-b py-2 last:border-b-0"
                data-slot="series-occurrence"
                data-stage={occurrence.stage}
                key={occurrence.id}
              >
                <Link
                  className="font-medium text-sm underline-offset-4 hover:underline"
                  params={{ id: occurrence.id }}
                  to="/admin/maintenance/$id"
                >
                  <When at={occurrence.startsAt} clock={clock} now={page.now} />
                </Link>
                <span className="flex items-center gap-3 text-muted-foreground text-sm tabular-nums">
                  {formatDuration(
                    locale,
                    occurrence.endsAt - occurrence.startsAt
                  )}
                  <StageBadge stage={occurrence.stage} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface SeriesDraft {
  readonly recurrence: RecurrenceDraft;
  readonly text: SeriesTextDraft;
}

/** The series' own form, which starts over from the series whenever a save moved it. */
function SeriesForm({
  clock,
  edit,
  onChanged,
  page,
}: {
  readonly clock: TimeOptions;
  readonly edit: (
    input: SeriesInput
  ) => Promise<MaintenanceSeriesSaveResult | undefined>;
  readonly onChanged: () => void;
  readonly page: MaintenanceSeriesPage;
}): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const { series } = page;
  const [draft, setDraft] = useState<SeriesDraft>(() => seriesDraftOf(series));
  const onText = useCallback(
    (update: (current: SeriesTextDraft) => SeriesTextDraft) =>
      setDraft((current) => ({ ...current, text: update(current.text) })),
    []
  );
  const onRecurrence = useCallback(
    (update: (current: RecurrenceDraft) => RecurrenceDraft) =>
      setDraft((current) => ({
        ...current,
        recurrence: update(current.recurrence),
      })),
    []
  );
  const onComponent = useCallback(
    (id: string, chosen: boolean) =>
      onText((current) => ({
        ...current,
        componentIds: chosenOf(current.componentIds, id, chosen),
      })),
    [onText]
  );
  const formRef = useRef<HTMLFormElement>(null);
  const judge = useCallback(
    (current: SeriesDraft): WindowFieldErrors => {
      const parsed = seriesInputOf(current.text, current.recurrence, language);
      return parsed.ok ? {} : parsed.errors;
    },
    [language]
  );
  const { clear, errors, refuse } = useRefusedFields(formRef, draft, judge);
  const saving = useSaveFlow<SeriesDraft, MaintenanceRefusal>(draft);
  const { report } = saving;
  const [seen, setSeen] = useState(series.updatedAt);
  if (seen !== series.updatedAt) {
    const stored = seriesDraftOf(series);
    setSeen(series.updatedAt);
    setDraft(stored);
    report({ baseline: stored, draft: stored, kind: "rebased" });
  }
  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = seriesInputOf(draft.text, draft.recurrence, language);
      if (!parsed.ok) {
        refuse(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      clear();
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      const outcome = outcomeOf(
        await edit(parsed.input).catch(() => undefined)
      );
      report({ draft, ...outcome });
      if (outcome.kind === "saved") {
        onChanged();
      }
    },
    [clear, draft, edit, language, onChanged, refuse, report]
  );
  return (
    <form
      className="flex flex-col gap-6"
      data-slot="series-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
      ref={formRef}
    >
      <Alert data-slot="series-edit-hint">
        <AlertDescription>{t("maintenance_series_edit_hint")}</AlertDescription>
      </Alert>
      <DetailsCard
        draft={draft.text}
        errors={errors}
        footer={null}
        onDraft={onText}
      />
      <RecurrenceCard
        clock={clock}
        errors={errors}
        key={series.updatedAt}
        lead={
          <RepeatChoice
            onRecurrence={onRecurrence}
            series
            value={draft.recurrence.repeat}
          />
        }
        now={page.now}
        onRecurrence={onRecurrence}
        recurrence={draft.recurrence}
      />
      <ComponentsCard
        chosen={draft.text.componentIds}
        components={page.components}
        errors={errors}
        footer={
          <SaveFooter
            pendingLabel={t("maintenance_saving")}
            refusals={refusalWords}
            saved="maintenance_series_saved"
            slot="save-series"
            view={saving}
          />
        }
        onComponent={onComponent}
      />
    </form>
  );
}
