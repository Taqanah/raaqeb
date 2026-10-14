/**
 * An incident's page: its impact level, stage, affected
 * components and duration; the update editor above the timeline while it
 * is open, where choosing "resolved" swaps the statuses for the keep
 * choice; the updates newest first, each with its
 * statuses and a fix of its text; the title and impact edit; and delete.
 * Messages are plain text; each paragraph picks its own direction. Every write reads the page again.
 */
import {
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ContentField,
  ContentText,
  useContentIn,
  useInstallLanguage,
} from "@/admin/shell/content.tsx";
import { formWithPanel, Page } from "@/admin/shell/page.tsx";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import {
  SaveButton,
  SaveFooter,
  SaveLine,
} from "@/admin/shell/save-footer.tsx";
import {
  affectedComponents,
  incidentStage,
  latestStatuses,
} from "@/shared/domain/incidents.ts";
import { formatDuration, type TimeOptions } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Content,
  type ContentDraft,
  contentDraftOf,
} from "@/shared/schemas/content.ts";
import {
  type ImpactLevel,
  type IncidentComponent,
  type IncidentDeleteResult,
  type IncidentFields,
  type IncidentPage as IncidentPageRead,
  type IncidentRefusal,
  type IncidentSaveResult,
  type IncidentStatus,
  type IncidentUpdate,
  type IncidentUpdateInput,
  impactLevels,
  incidentMessageMaxLength,
  incidentStages,
  incidentTitleMaxLength,
} from "@/shared/schemas/incident.ts";
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
import { Button } from "@/shared/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { PencilIcon, TrashIcon } from "@/shared/ui/icons.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { AffectedComponents } from "./affected-components.tsx";
import {
  type FieldsDraft,
  fieldsDraftOf,
  fieldsInputOf,
  fixInputOf,
  type IncidentFieldErrors,
  type UpdateDraft,
  updateDraftOf,
  updateInputOf,
} from "./incident-draft.ts";
import {
  ImpactBadge,
  refusalWords,
  StageBadge,
  When,
} from "./incident-words.tsx";
import { ImpactChoice } from "./new-incident-form.tsx";
import { StageSteps } from "./stage-steps.tsx";

/** A fix's refusals: an invalid one is its text, the only field it has. */
const fixRefusals: Readonly<Record<IncidentRefusal, MessageId>> = {
  ...refusalWords,
  invalid: "incident_refused_message",
};

/** A save's outcome from its answer: nothing when the session check redirected and the page is leaving. */
function outcomeOf(
  result: IncidentSaveResult | undefined
):
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly reason: IncidentRefusal } {
  if (!result) {
    return { kind: "failed", reason: "unavailable" };
  }
  return result.ok
    ? { kind: "saved" }
    : { kind: "failed", reason: result.reason };
}

export interface IncidentPageProps {
  readonly clock: TimeOptions;
  readonly edit: (
    fields: IncidentFields
  ) => Promise<IncidentSaveResult | undefined>;
  readonly fix: (
    updateId: string,
    message: Content
  ) => Promise<IncidentSaveResult | undefined>;
  /** Called after every save, so the page reads itself again. */
  readonly onChanged: () => void;
  /** Called once the incident is deleted. */
  readonly onRemoved: () => void;
  readonly page: IncidentPageRead;
  readonly post: (
    input: IncidentUpdateInput
  ) => Promise<IncidentSaveResult | undefined>;
  readonly remove: () => Promise<IncidentDeleteResult | undefined>;
}

export function IncidentPage({
  clock,
  edit,
  fix,
  onChanged,
  onRemoved,
  page,
  post,
  remove,
}: IncidentPageProps): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  const { incident } = page;
  const open = incident.resolvedAt === undefined;
  return (
    <Page
      parent={{ label: t("incident_list_title"), to: "/admin/incidents" }}
      title={text(incident.title)}
    >
      <div className={cn("grid items-start gap-6", formWithPanel)}>
        <div className="flex flex-col gap-6">
          <Summary clock={clock} page={page} />
          {open ? (
            <UpdateEditor onChanged={onChanged} page={page} post={post} />
          ) : (
            <ResolvedNote />
          )}
          <Timeline clock={clock} fix={fix} onChanged={onChanged} page={page} />
        </div>
        <div className="flex flex-col gap-6">
          <EditFields
            edit={edit}
            impact={incident.impact}
            onChanged={onChanged}
            title={incident.title}
          />
          <DeleteIncident onRemoved={onRemoved} remove={remove} />
        </div>
      </div>
    </Page>
  );
}

/** The incident at a glance: impact, stage, when it started, how long it lasted, and each affected component's status now. */
function Summary({
  clock,
  page,
}: {
  readonly clock: TimeOptions;
  readonly page: IncidentPageRead;
}): ReactNode {
  const { locale, t } = useMessages();
  const { incident, now } = page;
  const byId = new Map(page.components.map((each) => [each.id, each]));
  const affected = affectedComponents(incident).flatMap(
    (id) => byId.get(id) ?? []
  );
  return (
    <Card data-slot="incident-summary">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <ImpactBadge impact={incident.impact} />
          <StageBadge stage={incidentStage(incident)} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">
            {t("incident_column_started")}
          </dt>
          <dd>
            <When at={incident.createdAt} clock={clock} now={now} />
          </dd>
          <dt className="text-muted-foreground">
            {t("incident_column_duration")}
          </dt>
          <dd data-slot="incident-duration">
            {incident.resolvedAt === undefined
              ? t("incident_open_for", {
                  duration: formatDuration(locale, now - incident.createdAt),
                })
              : t("incident_lasted", {
                  duration: formatDuration(
                    locale,
                    incident.resolvedAt - incident.createdAt
                  ),
                })}
          </dd>
        </dl>
        {affected.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("incident_affects_none")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">
              {t("component_status_now")}
            </span>
            <ul className="flex flex-wrap gap-3" data-slot="incident-affected">
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

function ResolvedNote(): ReactNode {
  const { t } = useMessages();
  return (
    <Alert data-slot="incident-resolved-note">
      <AlertDescription>{t("incident_resolved_note")}</AlertDescription>
    </Alert>
  );
}

/** The next update: a stage, a text, and each affected component's status, or on resolving the keep choice. */
function UpdateEditor({
  onChanged,
  page,
  post,
}: {
  readonly onChanged: () => void;
  readonly page: IncidentPageRead;
  readonly post: (
    input: IncidentUpdateInput
  ) => Promise<IncidentSaveResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const [draft, setDraft] = useState(() => updateDraftOf(page.incident));
  const [errors, setErrors] = useState<IncidentFieldErrors>({});
  const saving = useSaveFlow<UpdateDraft, IncidentRefusal>(draft);
  const { report } = saving;
  const locked = affectedComponents(page.incident);
  const resolving = draft.stage === "resolved";
  // Keep reaches only a component set by hand; with none affected there is nothing to keep.
  const byHand = page.components.some(
    (each) => !each.linked && locked.includes(each.id)
  );
  // A new latest update, posted here or elsewhere, is what the next one starts from; the text typed stays.
  const latestId = page.incident.updates.at(-1)?.id;
  const [basis, setBasis] = useState(latestId);
  if (basis !== latestId) {
    const next = { ...draft, statuses: latestStatuses(page.incident) };
    setBasis(latestId);
    setDraft(next);
    report({
      baseline: updateDraftOf(page.incident),
      draft: next,
      kind: "rebased",
    });
  }

  const onStage = useCallback((value: unknown) => {
    const chosen = incidentStages.find((stage) => stage === value);
    if (chosen) {
      setDraft((current) => ({ ...current, stage: chosen }));
    }
  }, []);
  const onMessage = useCallback((message: ContentDraft) => {
    setDraft((current) => ({ ...current, message }));
  }, []);
  const onStatuses = useCallback((statuses: IncidentStatus[]) => {
    setDraft((current) => ({ ...current, statuses }));
  }, []);
  const onKeep = useCallback((checked: boolean) => {
    setDraft((current) => ({ ...current, keep: checked }));
  }, []);
  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = updateInputOf(draft, language);
      if (!parsed.ok) {
        setErrors(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      setErrors({});
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      const outcome = outcomeOf(
        await post(parsed.input).catch(() => undefined)
      );
      if (
        outcome.kind === "failed" &&
        (outcome.reason === "changed" || outcome.reason === "invalid")
      ) {
        // The server read a newer incident than this page: read it again and say so.
        report({ draft, kind: "failed", reason: "changed" });
        onChanged();
        return;
      }
      if (outcome.kind === "failed") {
        report({ draft, kind: "failed", reason: outcome.reason });
        return;
      }
      // The posted text clears; the next update starts from the stage just posted.
      const next = {
        ...draft,
        keep: false,
        message: contentDraftOf(undefined),
      };
      setDraft(next);
      report({ draft: next, kind: "saved" });
      onChanged();
    },
    [draft, language, onChanged, post, report]
  );

  return (
    <form
      data-slot="incident-update-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
    >
      <Card>
        <CardHeader divided>
          <CardTitle>{t("incident_section_update")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field>
            <FieldLabel>{t("incident_field_stage")}</FieldLabel>
            <StageSteps
              label={t("incident_field_stage")}
              onStage={onStage}
              stages={incidentStages}
              value={draft.stage}
            />
          </Field>
          <ContentField
            description={t("incident_field_message_hint")}
            error={errors.message && t(errors.message)}
            id="message"
            label={t("incident_field_message")}
            max={incidentMessageMaxLength}
            multiline={4}
            onChange={onMessage}
            required={language}
            value={draft.message}
          />
          {resolving ? (
            <Field>
              {byHand ? (
                <Field className="w-auto" orientation="horizontal">
                  <Checkbox
                    checked={draft.keep}
                    data-slot="incident-keep"
                    id="keep"
                    name="keep"
                    onCheckedChange={onKeep}
                  />
                  <FieldLabel htmlFor="keep">
                    {t("incident_resolve_keep")}
                  </FieldLabel>
                </Field>
              ) : null}
              <FieldDescription>{t("incident_resolve_hint")}</FieldDescription>
            </Field>
          ) : (
            <Field>
              <FieldLabel>{t("incident_section_components")}</FieldLabel>
              <FieldDescription>
                {t("incident_section_components_hint")}
              </FieldDescription>
              <AffectedComponents
                components={page.components}
                locked={locked}
                onChange={onStatuses}
                statuses={draft.statuses}
              />
              {errors.components ? (
                <FieldError>{t(errors.components)}</FieldError>
              ) : null}
            </Field>
          )}
        </CardContent>
        <SaveFooter
          fresh
          label={t("incident_post")}
          pendingLabel={t("incident_posting")}
          refusals={refusalWords}
          saved="incident_posted"
          slot="post-update"
          view={saving}
        />
      </Card>
    </form>
  );
}

/** The updates newest first, each with its stage, time, author, text and statuses. */
function Timeline({
  clock,
  fix,
  onChanged,
  page,
}: {
  readonly clock: TimeOptions;
  readonly fix: (
    updateId: string,
    message: Content
  ) => Promise<IncidentSaveResult | undefined>;
  readonly onChanged: () => void;
  readonly page: IncidentPageRead;
}): ReactNode {
  const { t } = useMessages();
  const byId = new Map(page.components.map((each) => [each.id, each]));
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("incident_section_timeline")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col" data-slot="incident-timeline">
          {page.incident.updates.toReversed().map((update) => (
            <UpdateItem
              byId={byId}
              clock={clock}
              fix={fix}
              key={update.id}
              now={page.now}
              onChanged={onChanged}
              update={update}
            />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function UpdateItem({
  byId,
  clock,
  fix,
  now,
  onChanged,
  update,
}: {
  readonly byId: ReadonlyMap<string, IncidentComponent>;
  readonly clock: TimeOptions;
  readonly fix: (
    updateId: string,
    message: Content
  ) => Promise<IncidentSaveResult | undefined>;
  readonly now: number;
  readonly onChanged: () => void;
  readonly update: IncidentUpdate;
}): ReactNode {
  const { t } = useMessages();
  const [fixing, setFixing] = useState(false);
  const startFixing = useCallback(() => setFixing(true), []);
  const stopFixing = useCallback(() => setFixing(false), []);
  // The Fix button goes while the form is open, so the focus it held moves into the form and comes back to the button.
  const fixButton = useRef<HTMLButtonElement>(null);
  const wasFixing = useRef<boolean>(false);
  useEffect(() => {
    if (wasFixing.current && !fixing) {
      fixButton.current?.focus();
    }
    wasFixing.current = fixing;
  }, [fixing]);
  return (
    <li
      className="flex flex-col gap-2 border-border border-b py-4 first:pt-0 last:border-b-0 last:pb-0"
      data-slot="incident-update"
      data-stage={update.stage}
      data-update={update.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StageBadge stage={update.stage} />
        <span className="text-muted-foreground">
          <When at={update.createdAt} clock={clock} now={now} />
        </span>
        <Token className="text-muted-foreground">{update.author}</Token>
        {fixing ? null : (
          <Button
            className="ms-auto"
            data-slot="fix-update"
            onClick={startFixing}
            ref={fixButton}
            size="sm"
            type="button"
            variant="ghost"
          >
            <PencilIcon />
            {t("incident_fix")}
          </Button>
        )}
      </div>
      {fixing ? (
        <FixText
          fix={fix}
          onChanged={onChanged}
          onDone={stopFixing}
          update={update}
        />
      ) : (
        <Message content={update.message} />
      )}
      {update.statuses.length > 0 ? (
        <ul className="flex flex-wrap gap-3" data-slot="update-statuses">
          {update.statuses.flatMap((each) => {
            const component = byId.get(each.componentId);
            return component
              ? [
                  <li
                    className="flex items-center gap-2 text-xs"
                    key={each.componentId}
                  >
                    <ContentText content={component.name} />
                    <StatusLevelBadge level={each.status} />
                  </li>,
                ]
              : [];
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** A blank line between two paragraphs. */
const paragraphBreak = /\n\s*\n/;

/** Plain text in paragraphs, each laid out in its own language's direction: the operator language's, else the install language's. */
function Message({ content }: { readonly content: Content }): ReactNode {
  const text = useContentIn()(content);
  return (
    <div className="flex flex-col gap-2 text-sm" data-slot="update-message">
      {text.split(paragraphBreak).map((paragraph, index) => (
        <p
          className="whitespace-pre-line"
          dir="auto"
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one fixed text; the list never reorders
          key={index}
        >
          {paragraph}
        </p>
      ))}
    </div>
  );
}

/** A fix of one update's text; its time, stage and statuses stay. */
function FixText({
  fix,
  onChanged,
  onDone,
  update,
}: {
  readonly fix: (
    updateId: string,
    message: Content
  ) => Promise<IncidentSaveResult | undefined>;
  readonly onChanged: () => void;
  readonly onDone: () => void;
  readonly update: IncidentUpdate;
}): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const [message, setMessage] = useState(() => contentDraftOf(update.message));
  const saving = useSaveFlow<ContentDraft, IncidentRefusal>(message);
  const { report } = saving;
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector("textarea")?.focus();
  }, []);
  const onSave = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = fixInputOf(message, language);
      if (!parsed.ok) {
        report({ draft: message, kind: "failed", reason: "invalid" });
        return;
      }
      if (!report({ draft: message, kind: "pending" })) {
        return;
      }
      const outcome = outcomeOf(
        await fix(update.id, parsed.input).catch(() => undefined)
      );
      report({ draft: message, ...outcome });
      if (outcome.kind === "saved") {
        onDone();
        onChanged();
      }
    },
    [fix, language, message, onChanged, onDone, report, update.id]
  );
  return (
    <form
      className="flex flex-col gap-2"
      data-slot="fix-form"
      method="post"
      noValidate
      onSubmit={onSave}
      ref={form}
    >
      <ContentField
        description={t("incident_fix_hint")}
        id={`fix-message-${update.id}`}
        label={t("incident_field_message")}
        max={incidentMessageMaxLength}
        multiline={4}
        onChange={setMessage}
        required={language}
        value={message}
      />
      <div className="flex flex-wrap items-center gap-2">
        <SaveButton
          label={t("incident_fix_save")}
          slot="save-fix"
          view={saving}
        />
        <Button onClick={onDone} type="button" variant="outline">
          {t("app_cancel")}
        </Button>
        <SaveLine line={saving.line} refusals={fixRefusals} />
      </div>
    </form>
  );
}

/** The title and the impact level, open or resolved. */
function EditFields({
  edit,
  impact,
  onChanged,
  title,
}: {
  readonly edit: (
    fields: IncidentFields
  ) => Promise<IncidentSaveResult | undefined>;
  readonly impact: ImpactLevel;
  readonly onChanged: () => void;
  readonly title: Content;
}): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const [draft, setDraft] = useState(() => fieldsDraftOf({ impact, title }));
  const [errors, setErrors] = useState<IncidentFieldErrors>({});
  const saving = useSaveFlow<FieldsDraft, IncidentRefusal>(draft);
  const { report } = saving;
  const onTitle = useCallback((value: ContentDraft) => {
    setDraft((current) => ({ ...current, title: value }));
  }, []);
  const onImpact = useCallback((value: unknown) => {
    const chosen = impactLevels.find((level) => level === value);
    if (chosen) {
      setDraft((current) => ({ ...current, impact: chosen }));
    }
  }, []);
  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = fieldsInputOf(draft, language);
      if (!parsed.ok) {
        setErrors(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      setErrors({});
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
    [draft, edit, language, onChanged, report]
  );
  return (
    <form
      data-slot="incident-edit-form"
      method="post"
      noValidate
      onSubmit={onSubmit}
    >
      <Card>
        <CardHeader divided>
          <CardTitle>{t("incident_section_edit")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ContentField
            description={t("incident_field_title_hint")}
            error={errors.title && t(errors.title)}
            id="title"
            label={t("incident_field_title")}
            max={incidentTitleMaxLength}
            onChange={onTitle}
            required={language}
            value={draft.title}
          />
          <ImpactChoice impact={draft.impact} onImpact={onImpact} />
        </CardContent>
        <SaveFooter
          pendingLabel={t("incident_saving")}
          refusals={refusalWords}
          saved="incident_saved"
          slot="save-incident"
          view={saving}
        />
      </Card>
    </form>
  );
}

/** Delete, after the operator confirms. */
function DeleteIncident({
  onRemoved,
  remove,
}: {
  readonly onRemoved: () => void;
  readonly remove: () => Promise<IncidentDeleteResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<IncidentRefusal | undefined>();
  const ask = useCallback(() => setOpen(true), []);
  const confirm = useCallback(async () => {
    const result = await remove().catch(() => undefined);
    if (result?.ok) {
      onRemoved();
      return;
    }
    setRefused(result?.ok === false ? result.reason : "unavailable");
  }, [onRemoved, remove]);
  return (
    <div className="flex flex-col gap-2">
      <Button
        className="self-start"
        data-slot="delete-incident"
        onClick={ask}
        type="button"
        variant="destructive-outline"
      >
        <TrashIcon />
        {t("incident_delete")}
      </Button>
      {refused ? (
        <p className="text-destructive text-sm" role="alert">
          {t(refusalWords[refused])}
        </p>
      ) : null}
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("incident_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("incident_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-delete"
              onClick={confirm}
              variant="destructive"
            >
              {t("incident_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
