/**
 * The maintenance window screens: the new
 * window's form, and a window's page with its summary, the same form and
 * what its stage allows beside it. The title and the description, the
 * start and the end typed to the minute on the operator's clock, and the
 * affected components with their status now. While scheduled every field
 * changes and the window may be cancelled; in progress only the text and
 * the end change and it may be ended now; completed only the text. A new
 * window may repeat weekly or monthly instead, which creates a maintenance
 * series; an occurrence's page names its series. Every
 * write reads the page again; a save the scheduler overtook says so and
 * keeps the text typed.
 */
import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { When } from "@/admin/incidents/incident-words.tsx";
import {
  ContentField,
  ContentText,
  useContentIn,
  useInstallLanguage,
} from "@/admin/shell/content.tsx";
import { formWidth, Page } from "@/admin/shell/page.tsx";
import { useRefusedFields } from "@/admin/shell/refused-fields.ts";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import {
  formatDuration,
  type TimeOptions,
  zoneLabel,
} from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ContentDraft } from "@/shared/schemas/content.ts";
import type {
  MaintenanceComponent,
  MaintenanceDeleteResult,
  MaintenanceEditInput,
  MaintenanceInput,
  MaintenancePage,
  MaintenanceRefusal,
  MaintenanceSaveResult,
  MaintenanceSeries,
  MaintenanceSeriesSaveResult,
  MaintenanceStage,
  MaintenanceWindow,
  NewMaintenance,
  SeriesInput,
} from "@/shared/schemas/maintenance.ts";
import {
  maintenanceMessageMaxLength,
  maintenanceTitleMaxLength,
} from "@/shared/schemas/maintenance.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog.tsx";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { FieldError } from "@/shared/ui/field.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import { RecurrenceCard, RepeatChoice } from "./recurrence-card.tsx";
import {
  type RecurrenceDraft,
  recurrenceDraftOf,
  seriesInputOf,
} from "./series-draft.ts";
import { TimeField } from "./time-field.tsx";
import {
  editInputOf,
  newWindowDraftOf,
  newWindowInputOf,
  stageReadIn,
  type WindowDraft,
  type WindowFieldErrors,
  windowDraftOf,
} from "./window-draft.ts";
import { refusalWords, StageBadge } from "./window-words.tsx";

const listPath = "/admin/maintenance";

/** A save's outcome from its answer: nothing when the session check redirected and the page is leaving. */
export function outcomeOf(
  result:
    | MaintenanceSaveResult
    | MaintenanceSeriesSaveResult
    | MaintenanceDeleteResult
    | undefined
):
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly reason: MaintenanceRefusal } {
  if (!result) {
    return { kind: "failed", reason: "unavailable" };
  }
  return result.ok
    ? { kind: "saved" }
    : { kind: "failed", reason: result.reason };
}

export interface NewWindowFormProps {
  readonly clock: TimeOptions;
  readonly create: (
    input: MaintenanceInput
  ) => Promise<MaintenanceSaveResult | undefined>;
  readonly createSeries: (
    input: SeriesInput
  ) => Promise<MaintenanceSeriesSaveResult | undefined>;
  readonly form: NewMaintenance;
  /** Called with the scheduled window. */
  readonly onCreated: (window: MaintenanceWindow) => void;
  /** Called with the series created. */
  readonly onSeriesCreated: (series: MaintenanceSeries) => void;
}

/** The new form's draft: the window's fields and, unless it is once, how it repeats. */
interface NewDraft {
  readonly recurrence: RecurrenceDraft;
  readonly window: WindowDraft;
}

export function NewWindowForm({
  clock,
  create,
  createSeries,
  form,
  onCreated,
  onSeriesCreated,
}: NewWindowFormProps): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const [draft, setDraft] = useState((): NewDraft => {
    const window = newWindowDraftOf(form.now, clock.timeZone);
    return { recurrence: recurrenceDraftOf(window, clock.timeZone), window };
  });
  const repeats = draft.recurrence.repeat !== "once";
  const onWindow = useCallback(
    (update: (current: WindowDraft) => WindowDraft) =>
      setDraft((current) => ({ ...current, window: update(current.window) })),
    []
  );
  const onRecurrence = useCallback(
    (update: (current: RecurrenceDraft) => RecurrenceDraft) =>
      setDraft((current) => {
        const next = update(current.recurrence);
        // Leaving once, the picker starts from the start and length the window has now.
        const from =
          current.recurrence.repeat === "once" && next.repeat !== "once"
            ? {
                ...recurrenceDraftOf(current.window, clock.timeZone),
                repeat: next.repeat,
              }
            : next;
        return { ...current, recurrence: from };
      }),
    [clock.timeZone]
  );
  const parse = useCallback(
    (current: NewDraft) =>
      current.recurrence.repeat === "once"
        ? newWindowInputOf(current.window, clock.timeZone, Date.now(), language)
        : seriesInputOf(current.window, current.recurrence, language),
    [clock.timeZone, language]
  );
  const formRef = useRef<HTMLFormElement>(null);
  const judge = useCallback(
    (current: NewDraft): WindowFieldErrors => {
      const parsed = parse(current);
      return parsed.ok ? {} : parsed.errors;
    },
    [parse]
  );
  const { clear, errors, refuse } = useRefusedFields(formRef, draft, judge);
  const saving = useSaveFlow<NewDraft, MaintenanceRefusal>(draft);
  const { report } = saving;
  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const recurring = draft.recurrence.repeat !== "once";
      const parsed = recurring
        ? seriesInputOf(draft.window, draft.recurrence, language)
        : newWindowInputOf(draft.window, clock.timeZone, Date.now(), language);
      if (!parsed.ok) {
        refuse(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      clear();
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      if ("recurrence" in parsed.input) {
        const result = await createSeries(parsed.input).catch(() => undefined);
        report({ draft, ...outcomeOf(result) });
        if (result?.ok) {
          onSeriesCreated(result.series);
        }
        return;
      }
      const result = await create(parsed.input).catch(() => undefined);
      report({ draft, ...outcomeOf(result) });
      if (result?.ok) {
        onCreated(result.window);
      }
    },
    [
      clear,
      clock.timeZone,
      create,
      createSeries,
      draft,
      language,
      onCreated,
      onSeriesCreated,
      refuse,
      report,
    ]
  );
  const repeat = (
    <RepeatChoice onRecurrence={onRecurrence} value={draft.recurrence.repeat} />
  );
  return (
    <Page
      parent={{ label: t("maintenance_list_title"), to: "/admin/maintenance" }}
      title={t("maintenance_new_title")}
    >
      <form
        className={cn("flex flex-col gap-6", formWidth)}
        data-slot="new-window-form"
        method="post"
        noValidate
        onSubmit={onSubmit}
        ref={formRef}
      >
        {/* Said before anything is written: a window needs a component. */}
        {form.components.length === 0 ? (
          <Alert data-slot="needs-component">
            <AlertDescription>
              {t("maintenance_needs_component")}{" "}
              <Link
                className="underline underline-offset-4"
                to="/admin/components/new"
              >
                {t("component_add")}
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
        <WindowFields
          clock={clock}
          components={form.components}
          draft={draft.window}
          errors={errors}
          footer={
            <SaveFooter
              disabled={form.components.length === 0}
              fresh
              label={t(
                repeats ? "maintenance_series_create" : "maintenance_create"
              )}
              pendingLabel={t("maintenance_creating")}
              refusals={refusalWords}
              slot="create-window"
              view={saving}
            >
              <Link
                className={buttonVariants({ variant: "outline" })}
                to={listPath}
              >
                {t("app_cancel")}
              </Link>
            </SaveFooter>
          }
          lead={repeat}
          now={form.now}
          onDraft={onWindow}
          stage="scheduled"
          times={
            repeats ? (
              <RecurrenceCard
                clock={clock}
                errors={errors}
                lead={repeat}
                now={form.now}
                onRecurrence={onRecurrence}
                recurrence={draft.recurrence}
              />
            ) : undefined
          }
        />
      </form>
    </Page>
  );
}

export interface WindowPageProps {
  readonly cancel: () => Promise<MaintenanceDeleteResult | undefined>;
  readonly clock: TimeOptions;
  readonly edit: (
    input: MaintenanceEditInput
  ) => Promise<MaintenanceSaveResult | undefined>;
  readonly end: () => Promise<MaintenanceSaveResult | undefined>;
  /** Called after every write, so the page reads itself again. */
  readonly onChanged: () => void;
  /** Called once the window is cancelled. */
  readonly onRemoved: () => void;
  readonly page: MaintenancePage;
}

export function WindowPage({
  cancel,
  clock,
  edit,
  end,
  onChanged,
  onRemoved,
  page,
}: WindowPageProps): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  const { window } = page;
  // The page reads itself again once the scheduler has moved the window, so it shows the stage it is at.
  useEffect(() => {
    const wait = stageReadIn(window, page.now);
    if (wait === undefined) {
      return;
    }
    const timer = setTimeout(onChanged, wait);
    return () => clearTimeout(timer);
  }, [onChanged, page.now, window]);
  // The stage's action sits beside the stage in the summary, at every width (the screenshot run).
  let action: ReactNode = null;
  if (window.stage === "in_progress") {
    action = (
      <Confirmed
        action={end}
        confirm="confirm-end"
        description="maintenance_end_now_description"
        label="maintenance_end_now"
        onChanged={onChanged}
        onDone={onChanged}
        slot="end-window"
        title="maintenance_end_now_title"
      />
    );
  } else if (window.stage === "scheduled") {
    action = (
      <Confirmed
        action={cancel}
        confirm="confirm-cancel"
        description="maintenance_cancel_description"
        destructive
        label="maintenance_cancel"
        onChanged={onChanged}
        onDone={onRemoved}
        slot="cancel-window"
        title="maintenance_cancel_title"
      />
    );
  }
  return (
    <Page
      parent={{ label: t("maintenance_list_title"), to: "/admin/maintenance" }}
      title={text(window.title)}
    >
      <div className={cn("flex flex-col gap-6", formWidth)}>
        <Summary action={action} clock={clock} page={page} />
        <EditForm clock={clock} edit={edit} onChanged={onChanged} page={page} />
      </div>
    </Page>
  );
}

/** The window at a glance: its stage with what the stage allows, its start, end and length, and each affected component's status now. */
function Summary({
  action,
  clock,
  page,
}: {
  readonly action: ReactNode;
  readonly clock: TimeOptions;
  readonly page: MaintenancePage;
}): ReactNode {
  const { locale, t } = useMessages();
  const { now, window } = page;
  const byId = new Map(page.components.map((each) => [each.id, each]));
  const affected = window.componentIds.flatMap((id) => byId.get(id) ?? []);
  return (
    <Card data-slot="window-summary">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <StageBadge stage={window.stage} />
          {action}
        </div>
        {page.series ? (
          <p
            className="text-muted-foreground text-sm"
            data-slot="window-series"
          >
            {t("maintenance_occurrence_of")}{" "}
            <Link
              className="font-medium text-foreground underline underline-offset-4"
              params={{ id: page.series.id }}
              to="/admin/maintenance/series/$id"
            >
              <ContentText content={page.series.title} />
            </Link>
            . {t("maintenance_occurrence_alone")}
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">
            {t("maintenance_column_starts")}
          </dt>
          <dd>
            <When at={window.startsAt} clock={clock} now={now} />
          </dd>
          <dt className="text-muted-foreground">
            {t("maintenance_column_ends")}
          </dt>
          <dd>
            <When at={window.endsAt} clock={clock} now={now} />
          </dd>
          <dt className="text-muted-foreground">
            {t("maintenance_column_duration")}
          </dt>
          <dd data-slot="window-duration">
            {formatDuration(locale, window.endsAt - window.startsAt)}
          </dd>
        </dl>
        {affected.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("maintenance_affects_none")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">
              {t("component_status_now")}
            </span>
            <ul className="flex flex-wrap gap-3" data-slot="window-affected">
              {affected.map((component) => (
                <li
                  className="flex items-center gap-2 text-sm"
                  data-component={component.id}
                  key={component.id}
                >
                  <span className="font-medium">
                    <ContentText content={component.name} />
                  </span>
                  <StatusLevelBadge level={component.status} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The stored window's form, which starts over from the window whenever the scheduler or a save moved it, keeping the text typed. */
function EditForm({
  clock,
  edit,
  onChanged,
  page,
}: {
  readonly clock: TimeOptions;
  readonly edit: (
    input: MaintenanceEditInput
  ) => Promise<MaintenanceSaveResult | undefined>;
  readonly onChanged: () => void;
  readonly page: MaintenancePage;
}): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const { window } = page;
  const [draft, setDraft] = useState(() =>
    windowDraftOf(window, clock.timeZone)
  );
  const formRef = useRef<HTMLFormElement>(null);
  const judge = useCallback(
    (current: WindowDraft): WindowFieldErrors => {
      const parsed = editInputOf(
        current,
        window.stage,
        clock.timeZone,
        Date.now(),
        language
      );
      return parsed.ok ? {} : parsed.errors;
    },
    [clock.timeZone, language, window.stage]
  );
  const { clear, errors, refuse } = useRefusedFields(formRef, draft, judge);
  const saving = useSaveFlow<WindowDraft, MaintenanceRefusal>(draft);
  const { report } = saving;
  const basis = `${window.stage}:${window.updatedAt}`;
  const [seen, setSeen] = useState(basis);
  if (seen !== basis) {
    const stored = windowDraftOf(window, clock.timeZone);
    const next = { ...stored, message: draft.message, title: draft.title };
    setSeen(basis);
    setDraft(next);
    report({ baseline: stored, draft: next, kind: "rebased" });
  }
  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = editInputOf(
        draft,
        window.stage,
        clock.timeZone,
        Date.now(),
        language
      );
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
      if (
        outcome.kind === "saved" ||
        (outcome.kind === "failed" && outcome.reason === "changed")
      ) {
        onChanged();
      }
    },
    [
      clear,
      clock.timeZone,
      draft,
      edit,
      language,
      onChanged,
      refuse,
      report,
      window.stage,
    ]
  );
  return (
    <form
      className="flex flex-col gap-6"
      data-slot="window-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
      ref={formRef}
    >
      {window.stage === "scheduled" ? null : (
        <Alert data-slot="window-locked">
          <AlertDescription>
            {window.stage === "in_progress"
              ? t("maintenance_locked_started")
              : t("maintenance_locked_completed")}
          </AlertDescription>
        </Alert>
      )}
      <WindowFields
        clock={clock}
        components={page.components}
        draft={draft}
        errors={errors}
        footer={
          <SaveFooter
            pendingLabel={t("maintenance_saving")}
            refusals={refusalWords}
            saved="maintenance_saved"
            slot="save-window"
            view={saving}
          />
        }
        now={page.now}
        onDraft={setDraft}
        stage={window.stage}
      />
    </form>
  );
}

/** A window's fields in up to three cards: what its stage still lets change, the rest left to the summary above. */
function WindowFields({
  clock,
  components,
  draft,
  errors,
  footer,
  lead,
  now,
  onDraft,
  stage,
  times,
}: {
  readonly clock: TimeOptions;
  readonly components: readonly MaintenanceComponent[];
  readonly draft: WindowDraft;
  readonly errors: WindowFieldErrors;
  /** The save's footer, on whichever card the stage leaves last. */
  readonly footer: ReactNode;
  /** Above the times: how a new window repeats. */
  readonly lead?: ReactNode;
  /** The server's read time, for the zone's label. */
  readonly now: number;
  readonly onDraft: (update: (current: WindowDraft) => WindowDraft) => void;
  readonly stage: MaintenanceStage;
  /** In place of the start and the end: a series' recurrence. */
  readonly times?: ReactNode;
}): ReactNode {
  const onTime = useCallback(
    (name: "ends" | "starts", value: string) =>
      onDraft((current) => ({ ...current, [name]: value })),
    [onDraft]
  );
  const onComponent = useCallback(
    (id: string, chosen: boolean) =>
      onDraft((current) => ({
        ...current,
        componentIds: chosenOf(current.componentIds, id, chosen),
      })),
    [onDraft]
  );
  const scheduled = stage === "scheduled";
  return (
    <>
      <DetailsCard
        draft={draft}
        errors={errors}
        footer={stage === "completed" ? footer : null}
        onDraft={onDraft}
      />
      {stage === "completed"
        ? null
        : (times ?? (
            <TimesCard
              clock={clock}
              draft={draft}
              errors={errors}
              footer={scheduled ? null : footer}
              lead={lead}
              now={now}
              onTime={onTime}
              scheduled={scheduled}
            />
          ))}
      {scheduled ? (
        <ComponentsCard
          chosen={draft.componentIds}
          components={components}
          errors={errors}
          footer={footer}
          onComponent={onComponent}
        />
      ) : null}
    </>
  );
}

/** The components chosen once one is ticked or unticked, the last ticked last. */
export function chosenOf(
  ids: readonly string[],
  id: string,
  chosen: boolean
): string[] {
  const rest = ids.filter((each) => each !== id);
  return chosen ? [...rest, id] : rest;
}

/** The text visitors read: the title and the description. */
export function DetailsCard<
  Draft extends Pick<WindowDraft, "message" | "title">,
>({
  draft,
  errors,
  footer,
  onDraft,
}: {
  readonly draft: Draft;
  readonly errors: WindowFieldErrors;
  readonly footer: ReactNode;
  readonly onDraft: (update: (current: Draft) => Draft) => void;
}): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const onTitle = useCallback(
    (title: ContentDraft) => onDraft((current) => ({ ...current, title })),
    [onDraft]
  );
  const onMessage = useCallback(
    (message: ContentDraft) => onDraft((current) => ({ ...current, message })),
    [onDraft]
  );
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("maintenance_section_details")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ContentField
          description={t("maintenance_field_title_hint")}
          error={errors.title && t(errors.title)}
          id="title"
          label={t("maintenance_field_title")}
          max={maintenanceTitleMaxLength}
          onChange={onTitle}
          required={language}
          value={draft.title}
        />
        <ContentField
          description={t("maintenance_field_message_hint")}
          error={errors.message && t(errors.message)}
          id="message"
          label={t("maintenance_field_message")}
          max={maintenanceMessageMaxLength}
          multiline={4}
          onChange={onMessage}
          required={language}
          value={draft.message}
        />
      </CardContent>
      {footer}
    </Card>
  );
}

/** The times: the start while the window is scheduled, the end until it completes. */
function TimesCard({
  clock,
  draft,
  errors,
  footer,
  lead,
  now,
  onTime,
  scheduled,
}: {
  readonly clock: TimeOptions;
  readonly draft: WindowDraft;
  readonly errors: WindowFieldErrors;
  readonly footer: ReactNode;
  /** Above the times: how the window repeats, on a new window. */
  readonly lead?: ReactNode;
  readonly now: number;
  readonly onTime: (name: "ends" | "starts", value: string) => void;
  readonly scheduled: boolean;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("maintenance_section_times")}</CardTitle>
        <CardDescription>{t("maintenance_times_hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {lead}
        <div className={cn("grid gap-5", scheduled && "sm:grid-cols-2")}>
          {scheduled ? (
            <TimeField
              clock={clock}
              error={errors.starts && t(errors.starts)}
              label={t("maintenance_field_starts")}
              name="starts"
              now={now}
              onChange={onTime}
              value={draft.starts}
            />
          ) : null}
          <TimeField
            clock={clock}
            error={errors.ends && t(errors.ends)}
            label={t("maintenance_field_ends")}
            name="ends"
            now={now}
            onChange={onTime}
            value={draft.ends}
          />
        </div>
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          {t("maintenance_times_zone")}
          {/* Localized words, not a machine token: isolated, in the text face. */}
          <bdi
            className="font-medium text-foreground"
            data-slot="window-zone"
            data-zone={clock.timeZone}
          >
            {zoneLabel(locale, now, clock.timeZone)}
          </bdi>
        </p>
      </CardContent>
      {footer}
    </Card>
  );
}

/** The components to tick, while the window is scheduled, and on a series. */
export function ComponentsCard({
  chosen,
  components,
  errors,
  footer,
  onComponent,
}: {
  readonly chosen: readonly string[];
  readonly components: readonly MaintenanceComponent[];
  readonly errors: WindowFieldErrors;
  readonly footer: ReactNode;
  readonly onComponent: (id: string, chosen: boolean) => void;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("maintenance_section_components")}</CardTitle>
        <CardDescription>
          {t("maintenance_section_components_hint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {components.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("maintenance_components_none")}
          </p>
        ) : (
          <ul className="flex flex-col" data-slot="window-components">
            {components.map((component) => (
              <ComponentChoice
                chosen={chosen.includes(component.id)}
                component={component}
                key={component.id}
                onChoose={onComponent}
              />
            ))}
          </ul>
        )}
        {errors.components ? (
          <FieldError>{t(errors.components)}</FieldError>
        ) : null}
      </CardContent>
      {footer}
    </Card>
  );
}

/** One component to tick, in the incident form's rows: its name, then its status now at the end. */
function ComponentChoice({
  chosen,
  component,
  onChoose,
}: {
  readonly chosen: boolean;
  readonly component: MaintenanceComponent;
  readonly onChoose: (id: string, chosen: boolean) => void;
}): ReactNode {
  const onChecked = useCallback(
    (checked: boolean) => onChoose(component.id, checked),
    [component.id, onChoose]
  );
  const id = `component-${component.id}`;
  return (
    <li
      className="flex min-h-control items-center gap-3 border-border border-b py-2 last:border-b-0"
      data-component={component.id}
      data-slot="window-component"
    >
      <Checkbox
        checked={chosen}
        id={id}
        name={id}
        onCheckedChange={onChecked}
      />
      <label className="flex min-w-0 flex-1" htmlFor={id}>
        <ContentText
          className="truncate font-medium text-sm"
          content={component.name}
        />
      </label>
      <StatusLevelBadge level={component.status} />
    </li>
  );
}

/** An action taken after the operator confirms: ending a window now, cancelling a scheduled one, or ending a series. A window the scheduler moved meanwhile reads the page again. */
export function Confirmed({
  action,
  confirm,
  description,
  destructive = false,
  label,
  onChanged,
  onDone,
  slot,
  title,
}: {
  readonly action: () => Promise<
    MaintenanceSaveResult | MaintenanceDeleteResult | undefined
  >;
  readonly confirm: string;
  readonly description: MessageId;
  /** A destructive action's button is red. */
  readonly destructive?: boolean;
  readonly label: MessageId;
  /** Called when the window moved since the page read it, so the page shows it as it is. */
  readonly onChanged: () => void;
  readonly onDone: () => void;
  readonly slot: string;
  readonly title: MessageId;
}): ReactNode {
  const { t } = useMessages();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<MaintenanceRefusal | undefined>();
  const ask = useCallback(() => setOpen(true), []);
  const confirmed = useCallback(async () => {
    const outcome = outcomeOf(await action().catch(() => undefined));
    if (outcome.kind === "saved") {
      setRefused(undefined);
      onDone();
      return;
    }
    if (outcome.kind === "failed") {
      setRefused(outcome.reason);
      if (outcome.reason === "changed") {
        onChanged();
      }
    }
  }, [action, onChanged, onDone]);
  return (
    <div className="flex flex-col items-end gap-2">
      <Button data-slot={slot} onClick={ask} type="button" variant="outline">
        {t(label)}
      </Button>
      {refused ? (
        <p className="text-destructive text-sm" role="alert">
          {t(
            refused === "changed" ? "maintenance_moved" : refusalWords[refused]
          )}
        </p>
      ) : null}
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("maintenance_keep")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot={confirm}
              onClick={confirmed}
              variant={destructive ? "destructive" : "default"}
            >
              {t(label)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
