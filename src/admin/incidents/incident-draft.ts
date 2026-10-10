/**
 * The incident forms' drafts: the new incident's title, impact
 * level, stage, affected components and first message; an update's stage,
 * message and statuses, or the resolving update's keep choice; the title
 * and impact edit; the fix of an update's text. Each text is written in each
 * locale, the install language's required. Each turns into what its
 * server function posts through
 * the shared schema, with one catalog message per refused field. An update
 * names every component the incident affects and may add one; a component
 * added in the draft may be taken out again before posting. Pure: the forms hold one draft in state and call these.
 */
import type { z } from "zod";
import { incidentStage, latestStatuses } from "@/shared/domain/incidents.ts";
import { worstStatus } from "@/shared/domain/status.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import {
  type Content,
  type ContentDraft,
  contentDraftOf,
  draftWrittenIn,
} from "@/shared/schemas/content.ts";
import {
  type ImpactLevel,
  type Incident,
  type IncidentCreateInput,
  type IncidentFields,
  type IncidentStage,
  type IncidentStatus,
  type IncidentUpdateInput,
  incidentCreateSchema,
  incidentFieldsSchema,
  incidentUpdateSchema,
  type NewIncident,
  type OpenStage,
  updateFixSchema,
} from "@/shared/schemas/incident.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";

export interface NewIncidentDraft {
  readonly impact: ImpactLevel;
  readonly message: ContentDraft;
  readonly stage: OpenStage;
  /** The affected components with their status, in the order they were added. */
  readonly statuses: readonly IncidentStatus[];
  readonly title: ContentDraft;
}

export interface UpdateDraft {
  /** On resolving: components set by hand keep the status the incident set rather than return to the status they had before. */
  readonly keep: boolean;
  readonly message: ContentDraft;
  readonly stage: IncidentStage;
  readonly statuses: readonly IncidentStatus[];
}

/** The refusal of each field that did not fit. */
export type IncidentFieldErrors = Readonly<
  Partial<Record<"components" | "message" | "title", MessageId>>
>;

export type DraftParse<Input> =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly errors: IncidentFieldErrors };

/** Content with no text in any locale. */
const emptyText = contentDraftOf(undefined);

const suggested: Readonly<Record<StatusLevel, ImpactLevel>> = {
  degraded_performance: "minor",
  major_outage: "critical",
  operational: "none",
  partial_outage: "major",
  under_maintenance: "none",
};

/** The impact level a status suggests, the summary's mapping read backwards: degraded performance is minor, partial outage major, major outage critical, anything else none. */
export function impactFor(level: StatusLevel): ImpactLevel {
  return suggested[level];
}

/** A new incident's draft: investigating, with the "open incident" link's title, written in the install language, and components when it came from one, and the impact their worst status suggests. */
export function newIncidentDraftOf(
  form: NewIncident,
  language: Locale
): NewIncidentDraft {
  const statuses = form.prefill?.statuses ?? [];
  return {
    impact: impactFor(worstStatus(statuses.map((each) => each.status))),
    message: emptyText,
    stage: "investigating",
    statuses,
    title: { ...emptyText, [language]: form.prefill?.title ?? "" },
  };
}

/** What the new-incident form posts, or the refusal of every field that does not fit; the title and the text need the install language's. */
export function newIncidentInputOf(
  draft: NewIncidentDraft,
  language: Locale
): DraftParse<IncidentCreateInput> {
  return parsed(incidentCreateSchema.safeParse(draft), draft, language);
}

/** An update's draft: the incident's stage and its latest statuses, keeping nothing. */
export function updateDraftOf(incident: Incident): UpdateDraft {
  return {
    keep: false,
    message: emptyText,
    stage: incidentStage(incident),
    statuses: latestStatuses(incident),
  };
}

/** What the update editor posts: the statuses at an open stage, the keep choice on resolving. */
export function updateInputOf(
  draft: UpdateDraft,
  language: Locale
): DraftParse<IncidentUpdateInput> {
  return parsed(
    incidentUpdateSchema.safeParse(
      draft.stage === "resolved"
        ? { keep: draft.keep, message: draft.message, stage: draft.stage }
        : {
            message: draft.message,
            stage: draft.stage,
            statuses: draft.statuses,
          }
    ),
    draft,
    language
  );
}

/** The title and impact edit as typed. */
export interface FieldsDraft {
  readonly impact: ImpactLevel;
  readonly title: ContentDraft;
}

/** The title and impact edit's draft of the stored incident. */
export function fieldsDraftOf(incident: IncidentFields): FieldsDraft {
  return { impact: incident.impact, title: contentDraftOf(incident.title) };
}

/** The title and impact edit's input, or the title's refusal. */
export function fieldsInputOf(
  draft: FieldsDraft,
  language: Locale
): DraftParse<IncidentFields> {
  return parsed(incidentFieldsSchema.safeParse(draft), draft, language);
}

/** A fix of one update's text, or its refusal. */
export function fixInputOf(
  message: ContentDraft,
  language: Locale
): DraftParse<Content> {
  const fixed = parsed(
    updateFixSchema.pick({ message: true }).safeParse({ message }),
    { message },
    language
  );
  return fixed.ok ? { input: fixed.input.message, ok: true } : fixed;
}

/** The statuses with one component's status set, added at the end when it was not there. */
export function withStatus(
  statuses: readonly IncidentStatus[],
  componentId: string,
  status: IncidentStatus["status"]
): IncidentStatus[] {
  return statuses.some((each) => each.componentId === componentId)
    ? statuses.map((each) =>
        each.componentId === componentId ? { componentId, status } : each
      )
    : [...statuses, { componentId, status }];
}

/** The statuses without one component, unless the incident already affects it: an update never takes one out. */
export function withoutComponent(
  statuses: readonly IncidentStatus[],
  componentId: string,
  affected: readonly string[]
): IncidentStatus[] {
  return affected.includes(componentId)
    ? [...statuses]
    : statuses.filter((each) => each.componentId !== componentId);
}

/** A parse's input, or one refusal per field its issues name and per text without the install language's. */
function parsed<Input>(
  result: z.ZodSafeParseResult<Input>,
  draft: { readonly message?: ContentDraft; readonly title?: ContentDraft },
  language: Locale
): DraftParse<Input> {
  const errors: Partial<Record<keyof IncidentFieldErrors, MessageId>> = {};
  for (const issue of result.error?.issues ?? []) {
    const [field] = issue.path;
    if (field === "statuses") {
      errors.components = "incident_refused_components";
    } else if (field === "title") {
      errors.title = "incident_refused_title";
    } else if (field === "message") {
      errors.message = "incident_refused_message";
    }
  }
  if (draft.title && !draftWrittenIn(draft.title, language, true)) {
    errors.title = "incident_missing_title";
  }
  if (draft.message && !draftWrittenIn(draft.message, language, true)) {
    errors.message = "incident_missing_message";
  }
  return result.success && Object.keys(errors).length === 0
    ? { input: result.data, ok: true }
    : { errors, ok: false };
}
