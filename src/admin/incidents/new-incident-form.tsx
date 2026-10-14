/**
 * The new-incident page: the title, the impact level, the
 * starting stage, the affected components with the status the incident sets
 * on each, and the first update's text. Opened from a down notification's
 * "open incident" link, it starts with the monitor's name and the
 * components linked to it. Publishing opens the incident's page.
 */
import { Link } from "@tanstack/react-router";
import { type ReactNode, type SubmitEvent, useCallback, useState } from "react";
import { ContentField, useInstallLanguage } from "@/admin/shell/content.tsx";
import { formWidth, Page } from "@/admin/shell/page.tsx";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { ContentDraft } from "@/shared/schemas/content.ts";
import {
  type ImpactLevel,
  type Incident,
  type IncidentCreateInput,
  type IncidentRefusal,
  type IncidentSaveResult,
  type IncidentStatus,
  impactLevels,
  incidentMessageMaxLength,
  incidentTitleMaxLength,
  type NewIncident,
  openStages,
} from "@/shared/schemas/incident.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { StatusDot } from "@/shared/ui/badge.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { AffectedComponents } from "./affected-components.tsx";
import {
  type IncidentFieldErrors,
  type NewIncidentDraft,
  newIncidentDraftOf,
  newIncidentInputOf,
} from "./incident-draft.ts";
import {
  impactVariants,
  impactWords,
  refusalWords,
} from "./incident-words.tsx";
import { StageSteps } from "./stage-steps.tsx";

const listPath = "/admin/incidents";

export interface NewIncidentFormProps {
  readonly create: (
    input: IncidentCreateInput
  ) => Promise<IncidentSaveResult | undefined>;
  readonly form: NewIncident;
  /** Called with the published incident. */
  readonly onCreated: (incident: Incident) => void;
  /** Called when the server knew components the page did not, so the page reads them again. */
  readonly onStale: () => void;
}

export function NewIncidentForm({
  create,
  form,
  onCreated,
  onStale,
}: NewIncidentFormProps): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const [draft, setDraft] = useState(() => newIncidentDraftOf(form, language));
  const [errors, setErrors] = useState<IncidentFieldErrors>({});
  const saving = useSaveFlow<NewIncidentDraft, IncidentRefusal>(draft);
  const { report } = saving;

  const onTitle = useCallback((title: ContentDraft) => {
    setDraft((current) => ({ ...current, title }));
  }, []);
  const onMessage = useCallback((message: ContentDraft) => {
    setDraft((current) => ({ ...current, message }));
  }, []);
  const onImpact = useCallback((value: unknown) => {
    const chosen = impactLevels.find((level) => level === value);
    if (chosen) {
      setDraft((current) => ({ ...current, impact: chosen }));
    }
  }, []);
  const onStage = useCallback((value: unknown) => {
    const chosen = openStages.find((stage) => stage === value);
    if (chosen) {
      setDraft((current) => ({ ...current, stage: chosen }));
    }
  }, []);
  const onStatuses = useCallback((statuses: IncidentStatus[]) => {
    setDraft((current) => ({ ...current, statuses }));
  }, []);

  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      // A component deleted since the page read its list is left out.
      const known = new Set(form.components.map((each) => each.id));
      const parsed = newIncidentInputOf(
        {
          ...draft,
          statuses: draft.statuses.filter((each) =>
            known.has(each.componentId)
          ),
        },
        language
      );
      if (!parsed.ok) {
        setErrors(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      setErrors({});
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      const result = await create(parsed.input).catch(() => undefined);
      if (!result) {
        report({ draft, kind: "failed", reason: "unavailable" });
        return;
      }
      if (!result.ok) {
        if (result.reason === "invalid") {
          // None of the chosen components exists any more: read the list again.
          setErrors({ components: "incident_refused_components" });
          onStale();
        }
        report({ draft, kind: "failed", reason: result.reason });
        return;
      }
      report({ draft, kind: "saved" });
      onCreated(result.incident);
    },
    [create, draft, form.components, language, onCreated, onStale, report]
  );

  return (
    <Page
      parent={{ label: t("incident_list_title"), to: "/admin/incidents" }}
      title={t("incident_new_title")}
    >
      <form
        className={cn("flex flex-col gap-6", formWidth)}
        data-slot="new-incident-form"
        method="post"
        noValidate
        onSubmit={onSubmit}
      >
        {/* Said before anything is written: an incident needs a component. */}
        {form.components.length === 0 ? (
          <Alert data-slot="needs-component">
            <AlertDescription>
              {t("incident_needs_component")}{" "}
              <Link
                className="underline underline-offset-4"
                to="/admin/components/new"
              >
                {t("component_add")}
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
        {form.prefill ? (
          <Alert data-slot="incident-prefilled">
            <AlertDescription>
              {form.prefill.statuses.length > 0
                ? t("incident_prefilled")
                : t("incident_prefilled_unlinked")}
            </AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader divided>
            <CardTitle>{t("incident_section_details")}</CardTitle>
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
            <Field>
              <FieldLabel>{t("incident_field_stage")}</FieldLabel>
              <StageSteps
                label={t("incident_field_stage")}
                onStage={onStage}
                stages={openStages}
                value={draft.stage}
              />
            </Field>
            <ContentField
              description={t("incident_field_message_hint")}
              error={errors.message && t(errors.message)}
              id="message"
              label={t("incident_field_message")}
              max={incidentMessageMaxLength}
              multiline={5}
              onChange={onMessage}
              required={language}
              value={draft.message}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader divided>
            <CardTitle>{t("incident_section_components")}</CardTitle>
            <CardDescription>
              {t("incident_section_components_hint")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <AffectedComponents
              components={form.components}
              locked={[]}
              onChange={onStatuses}
              statuses={draft.statuses}
            />
            {errors.components ? (
              <FieldError>{t(errors.components)}</FieldError>
            ) : null}
          </CardContent>
          <SaveFooter
            disabled={form.components.length === 0}
            fresh
            label={t("incident_create")}
            pendingLabel={t("incident_creating")}
            refusals={refusalWords}
            slot="create-incident"
            view={saving}
          >
            <Link
              className={buttonVariants({ variant: "outline" })}
              to={listPath}
            >
              {t("app_cancel")}
            </Link>
          </SaveFooter>
        </Card>
      </form>
    </Page>
  );
}

/** The impact level, a choice of four shown as their badges. */
export function ImpactChoice({
  impact,
  onImpact,
}: {
  readonly impact: ImpactLevel;
  readonly onImpact: (value: unknown) => void;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Field className="@container">
      <FieldLabel>{t("incident_field_impact")}</FieldLabel>
      {/* One row in severity order where it fits; two by two in the narrow side card, so none is left alone on a row. */}
      <Segmented
        aria-label={t("incident_field_impact")}
        className="@md:flex grid grid-cols-2"
        data-slot="incident-impact-choice"
        name="impact"
        onValueChange={onImpact}
        value={impact}
      >
        {impactLevels.map((level) => (
          <SegmentedItem key={level} value={level}>
            <StatusDot variant={impactVariants[level]} />
            {t(impactWords[level])}
          </SegmentedItem>
        ))}
      </Segmented>
      <FieldDescription>{t("incident_field_impact_hint")}</FieldDescription>
    </Field>
  );
}
