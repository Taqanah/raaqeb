/**
 * The component form's draft: the name and the description in
 * each locale, the linked monitors and the hand-set status as the operator
 * sets them, the input it posts through the shared schema, and one catalog
 * message per refused field. The name, and the description once it has
 * any text, need the install language's. The hand-set status is
 * kept whatever the links, since it shows again once the last monitor is
 * unlinked. Pure: the form holds one draft in state and calls these.
 */
import type { Locale } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import {
  type Component,
  type ComponentInput,
  componentInputSchema,
  type LinkableMonitor,
} from "@/shared/schemas/component.ts";
import {
  type ContentDraft,
  contentDraftOf,
  draftWrittenIn,
} from "@/shared/schemas/content.ts";
import type { HandSetLevel } from "@/shared/schemas/status.ts";

export interface ComponentDraft {
  readonly description: ContentDraft;
  readonly monitorIds: readonly string[];
  readonly name: ContentDraft;
  readonly status: HandSetLevel;
}

/** The refusal of each field that did not fit. */
export type ComponentFieldErrors = Readonly<
  Partial<Record<"description" | "name", MessageId>>
>;

export type ComponentDraftParse =
  | { readonly ok: true; readonly input: ComponentInput }
  | { readonly ok: false; readonly errors: ComponentFieldErrors };

/** The stored component's draft, or a new one: no links, operational. */
export function componentDraftOf(
  component: Component | undefined
): ComponentDraft {
  return {
    description: contentDraftOf(component?.description),
    monitorIds: component?.monitorIds ?? [],
    name: contentDraftOf(component?.name),
    status: component?.status ?? "operational",
  };
}

/** What the form posts, or the refusal of every field that does not fit; `language` is the install language, whose text the name needs. */
export function componentInputOf(
  draft: ComponentDraft,
  language: Locale
): ComponentDraftParse {
  const parsed = componentInputSchema.safeParse({
    description: draft.description,
    monitorIds: draft.monitorIds,
    name: draft.name,
    status: draft.status,
  });
  const errors: { description?: MessageId; name?: MessageId } = {};
  for (const issue of parsed.error?.issues ?? []) {
    if (issue.path[0] === "name") {
      errors.name = "component_refused_name";
    } else if (issue.path[0] === "description") {
      errors.description = "component_refused_description";
    }
  }
  if (!draftWrittenIn(draft.name, language, true)) {
    errors.name = "component_missing_name";
  }
  if (!draftWrittenIn(draft.description, language, false)) {
    errors.description = "component_missing_description";
  }
  return parsed.success && Object.keys(errors).length === 0
    ? { input: parsed.data, ok: true }
    : { errors, ok: false };
}

/** The draft with one monitor linked or unlinked. */
export function withMonitor(
  draft: ComponentDraft,
  monitorId: string,
  linked: boolean
): ComponentDraft {
  if (!linked) {
    return {
      ...draft,
      monitorIds: draft.monitorIds.filter((id) => id !== monitorId),
    };
  }
  return draft.monitorIds.includes(monitorId)
    ? draft
    : { ...draft, monitorIds: [...draft.monitorIds, monitorId] };
}

/** The monitors whose name or target holds the typed text, ignoring case; every one for no text. */
export function filterMonitors(
  monitors: readonly LinkableMonitor[],
  text: string
): LinkableMonitor[] {
  const needle = text.trim().toLowerCase();
  return monitors.filter(
    (monitor) =>
      needle === "" ||
      monitor.name.toLowerCase().includes(needle) ||
      (monitor.target?.toLowerCase().includes(needle) ?? false)
  );
}
