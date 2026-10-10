/**
 * The status page editor's draft: every field as the
 * operator types it, the ordered component list with its groups, and the
 * customization, turned into what the server function posts by the shared
 * schema. A refusal becomes one catalog message per field, keyed by the
 * path of the posted input (`slug`, `customization.footerLinks.0.url`, or
 * `layout.<group key>` for a group's name). The layout operations move,
 * add and remove components and groups; a component moves up and down
 * inside its group or the top level, and "move to" changes where it sits.
 * Pure: the editor holds one draft in state and calls these.
 */
import { isLocale, type Locale, locales } from "@/shared/i18n/locale.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import type { Theme } from "@/shared/schemas/appearance.ts";
import { type ContentDraft, contentDraftOf } from "@/shared/schemas/content.ts";
import {
  type BarLength,
  componentsOf,
  type PageCreateInput,
  type PageEditor,
  type PageInput,
  pageCreateSchema,
  pageInputSchema,
  type SubscriptionChannel,
} from "@/shared/schemas/page.ts";
import { type StatusLevel, statusLevels } from "@/shared/schemas/status.ts";

/** One entry of the draft's layout; a group carries a key that stays while it is edited. */
export type DraftItem =
  | { readonly kind: "component"; readonly componentId: string }
  | {
      readonly kind: "group";
      readonly componentIds: readonly string[];
      readonly key: string;
      readonly name: ContentDraft;
    };

/** One footer link row; the key stays while it is edited. */
export interface FooterLinkDraft {
  readonly key: string;
  readonly label: ContentDraft;
  readonly url: string;
}

export interface PageDraft {
  readonly barDays: BarLength;
  readonly bars: boolean;
  /** Empty is the default colour. */
  readonly brandColour: string;
  readonly contactUrl: string;
  readonly customCss: string;
  readonly customDomain: string;
  readonly description: ContentDraft;
  readonly footerLinks: readonly FooterLinkDraft[];
  readonly isDefault: boolean;
  /** A label empty in every locale is the default name. */
  readonly labels: Readonly<Record<StatusLevel, ContentDraft>>;
  readonly layout: readonly DraftItem[];
  readonly locale: Locale;
  readonly noindex: boolean;
  readonly percentages: boolean;
  readonly poweredBy: boolean;
  readonly published: boolean;
  readonly slug: string;
  /** An empty colour is the default. */
  readonly statusColours: Readonly<Record<StatusLevel, string>>;
  readonly subscriptions: readonly SubscriptionChannel[];
  readonly theme: Theme;
  readonly title: ContentDraft;
}

/** The first refusal of each field, by the path of the posted input. */
export type PageFieldErrors = Readonly<Partial<Record<string, MessageId>>>;

export type PageDraftParse =
  | { readonly ok: true; readonly input: PageInput }
  | { readonly ok: false; readonly errors: PageFieldErrors };

/** A value per status level. */
function perLevel<Value>(
  value: (level: StatusLevel) => Value
): Record<StatusLevel, Value> {
  return {
    degraded_performance: value("degraded_performance"),
    major_outage: value("major_outage"),
    operational: value("operational"),
    partial_outage: value("partial_outage"),
    under_maintenance: value("under_maintenance"),
  };
}

/** The editor's draft of the stored page. */
export function pageDraftOf(editor: PageEditor): PageDraft {
  const { page } = editor;
  const custom = page.customization;
  let groups = 0;
  return {
    barDays: custom.barDays,
    bars: custom.bars,
    brandColour: custom.brandColour ?? "",
    contactUrl: custom.contactUrl ?? "",
    customCss: custom.customCss ?? "",
    customDomain: page.customDomain ?? "",
    description: contentDraftOf(custom.description),
    footerLinks: custom.footerLinks.map((link, index) => ({
      key: `link-${index + 1}`,
      label: contentDraftOf(link.label),
      url: link.url,
    })),
    isDefault: page.isDefault,
    labels: perLevel((level) => contentDraftOf(custom.labels[level])),
    layout: editor.layout.map((item) => {
      if (item.kind === "component") {
        return item;
      }
      groups += 1;
      return {
        ...item,
        key: `group-${groups}`,
        name: contentDraftOf(item.name),
      };
    }),
    locale: page.locale,
    noindex: custom.noindex,
    percentages: custom.percentages,
    poweredBy: custom.poweredBy,
    published: page.published,
    slug: page.slug,
    statusColours: perLevel((level) => custom.statusColours[level] ?? ""),
    subscriptions: custom.subscriptions,
    theme: custom.theme,
    title: contentDraftOf(page.title),
  };
}

/** A typed text, or absent when it is only white space. */
function typed(text: string): string | undefined {
  return text.trim() === "" ? undefined : text;
}

/** Whether a form's content holds text in any locale. */
function written(draft: ContentDraft): boolean {
  return locales.some((locale) => typed(draft[locale]) !== undefined);
}

/** The levels a record gives a value, the rest absent. */
function typedPerLevel<Value>(
  values: Readonly<Record<StatusLevel, Value>>,
  given: (value: Value) => boolean
): Partial<Record<StatusLevel, Value>> {
  const kept: Partial<Record<StatusLevel, Value>> = {};
  for (const level of statusLevels) {
    if (given(values[level])) {
      kept[level] = values[level];
    }
  }
  return kept;
}

/** A refusal's path without the locale at its end, so it names the field. */
function fieldPath(path: readonly PropertyKey[]): string[] {
  const named = path.map(String);
  return isLocale(named.at(-1)) ? named.slice(0, -1) : named;
}

/** The message of each field refused by its exact path. */
const refusals: Readonly<Record<string, MessageId>> = {
  "customization.contactUrl": "page_refused_link",
  "customization.customCss": "page_refused_css",
  "customization.description": "page_refused_description",
  customDomain: "page_refused_domain",
  slug: "page_refused_slug",
  title: "page_refused_title",
};

/** The message of a refused field, by the path it posts to. */
function refusalOf(path: string): MessageId {
  const exact = refusals[path];
  if (exact) {
    return exact;
  }
  if (path.startsWith("customization.labels.")) {
    return "page_refused_label";
  }
  if (path.startsWith("customization.footerLinks.")) {
    return path.endsWith(".label")
      ? "page_refused_footer_label"
      : "page_refused_link";
  }
  return path.startsWith("layout.") ? "page_refused_group" : "app_form_invalid";
}

/** The key of the group at a top-level index, or the index for anything else. */
function groupKeyAt(layout: readonly DraftItem[], index: number): string {
  const item = layout[index];
  return item?.kind === "group" ? item.key : String(index);
}

/** What the editor posts, or the refusal of every field that does not fit. */
export function pageInputOf(draft: PageDraft): PageDraftParse {
  // A row left empty is not posted; a refusal names the row as the editor shows it.
  const rows = draft.footerLinks
    .map((link, row) => ({ link, row }))
    .filter(({ link }) => written(link.label) || link.url.trim() !== "");
  const parsed = pageInputSchema.safeParse({
    customDomain: typed(draft.customDomain),
    customization: {
      barDays: draft.barDays,
      bars: draft.bars,
      brandColour: typed(draft.brandColour),
      contactUrl: typed(draft.contactUrl),
      customCss: typed(draft.customCss),
      description: draft.description,
      footerLinks: rows.map(({ link }) => ({
        label: link.label,
        url: link.url,
      })),
      labels: typedPerLevel(draft.labels, written),
      noindex: draft.noindex,
      percentages: draft.percentages,
      poweredBy: draft.poweredBy,
      statusColours: typedPerLevel(
        draft.statusColours,
        (colour) => typed(colour) !== undefined
      ),
      subscriptions: draft.subscriptions,
      theme: draft.theme,
    },
    isDefault: draft.isDefault,
    layout: draft.layout.map((item) =>
      item.kind === "component"
        ? item
        : { componentIds: item.componentIds, kind: item.kind, name: item.name }
    ),
    locale: draft.locale,
    published: draft.published,
    slug: draft.slug,
    title: draft.title,
  });
  if (parsed.success) {
    return { input: parsed.data, ok: true };
  }
  const errors: Record<string, MessageId> = {};
  for (const issue of parsed.error.issues) {
    const path = fieldPath(issue.path);
    if (path[0] === "customization" && path[1] === "footerLinks") {
      path[2] = String(rows[Number(path[2])]?.row ?? path[2]);
    }
    const key =
      path[0] === "layout" && path.length > 1
        ? `layout.${groupKeyAt(draft.layout, Number(path[1]))}`
        : path.join(".");
    errors[key] = refusalOf(key);
  }
  return { errors, ok: false };
}

/** The new-page form's fields as typed. */
export interface NewPageDraft {
  readonly locale: Locale;
  readonly slug: string;
  readonly title: string;
}

export type NewPageDraftParse =
  | { readonly ok: true; readonly input: PageCreateInput }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<"slug" | "title", MessageId>>>;
    };

/** What the new-page form posts, or the refusal of each field. */
export function newPageInputOf(draft: NewPageDraft): NewPageDraftParse {
  const parsed = pageCreateSchema.safeParse(draft);
  if (parsed.success) {
    return { input: parsed.data, ok: true };
  }
  const errors: { slug?: MessageId; title?: MessageId } = {};
  for (const issue of parsed.error.issues) {
    if (issue.path[0] === "title") {
      errors.title = "page_refused_title";
    } else if (issue.path[0] === "slug") {
      errors.slug = "page_refused_slug";
    }
  }
  return { errors, ok: false };
}

/** The components the layout shows, in its order. */
export function placedComponents(layout: readonly DraftItem[]): string[] {
  return componentsOf(layout);
}

/** The layout with the component added at the end of the top level; unchanged when it is already placed. */
export function addComponent(
  layout: readonly DraftItem[],
  componentId: string
): DraftItem[] {
  return placedComponents(layout).includes(componentId)
    ? [...layout]
    : [...layout, { componentId, kind: "component" }];
}

/** The layout with a new, empty group at the end of the top level, under a key no other group has. */
export function addGroup(
  layout: readonly DraftItem[],
  name: ContentDraft
): DraftItem[] {
  const keys = new Set(
    layout.flatMap((item) => (item.kind === "group" ? [item.key] : []))
  );
  let number = keys.size + 1;
  while (keys.has(`group-${number}`)) {
    number += 1;
  }
  return [
    ...layout,
    { componentIds: [], key: `group-${number}`, kind: "group", name },
  ];
}

/** The list with the element at `index` swapped with its neighbour in `direction`; unchanged at an edge or for no element. */
function swapped<T>(list: readonly T[], index: number, direction: -1 | 1): T[] {
  const copy = [...list];
  const here = copy[index];
  const there = copy[index + direction];
  if (here === undefined || there === undefined) {
    return copy;
  }
  copy[index] = there;
  copy[index + direction] = here;
  return copy;
}

/** A component or a group, as the layout operations name it. */
export type LayoutEntry =
  | { readonly componentId: string }
  | { readonly groupKey: string };

/** The layout with the entry one place earlier (`-1`) or later (`1`) among its neighbours: a group or an ungrouped component at the top level, a grouped component inside its group. Unchanged at an edge. */
export function moveEntry(
  layout: readonly DraftItem[],
  entry: LayoutEntry,
  direction: -1 | 1
): DraftItem[] {
  const top = layout.findIndex((item) =>
    "groupKey" in entry
      ? item.kind === "group" && item.key === entry.groupKey
      : item.kind === "component" && item.componentId === entry.componentId
  );
  if (top >= 0 || "groupKey" in entry) {
    return swapped(layout, top, direction);
  }
  return layout.map((item) =>
    item.kind === "group" && item.componentIds.includes(entry.componentId)
      ? {
          ...item,
          componentIds: swapped(
            item.componentIds,
            item.componentIds.indexOf(entry.componentId),
            direction
          ),
        }
      : item
  );
}

/** The layout with the component moved to the end of a group, or of the top level with no key; unchanged for a group that is not there. */
export function moveComponentTo(
  layout: readonly DraftItem[],
  componentId: string,
  groupKey: string | undefined
): DraftItem[] {
  const without = removeComponent(layout, componentId);
  if (groupKey === undefined) {
    return [...without, { componentId, kind: "component" }];
  }
  if (!without.some((item) => item.kind === "group" && item.key === groupKey)) {
    return [...layout];
  }
  return without.map((item) =>
    item.kind === "group" && item.key === groupKey
      ? { ...item, componentIds: [...item.componentIds, componentId] }
      : item
  );
}

/** The layout without the component. */
export function removeComponent(
  layout: readonly DraftItem[],
  componentId: string
): DraftItem[] {
  return layout.flatMap((item): DraftItem[] => {
    if (item.kind === "component") {
      return item.componentId === componentId ? [] : [item];
    }
    return [
      {
        ...item,
        componentIds: item.componentIds.filter((id) => id !== componentId),
      },
    ];
  });
}

/** The layout without the group; its components stay, at the top level where the group was. */
export function removeGroup(
  layout: readonly DraftItem[],
  groupKey: string
): DraftItem[] {
  return layout.flatMap((item): DraftItem[] =>
    item.kind === "group" && item.key === groupKey
      ? item.componentIds.map((componentId) => ({
          componentId,
          kind: "component",
        }))
      : [item]
  );
}

/** The layout with the group renamed as typed. */
export function renameGroup(
  layout: readonly DraftItem[],
  groupKey: string,
  name: ContentDraft
): DraftItem[] {
  return layout.map((item) =>
    item.kind === "group" && item.key === groupKey ? { ...item, name } : item
  );
}

/** The group the component sits in, or nothing at the top level. */
export function groupOf(
  layout: readonly DraftItem[],
  componentId: string
): string | undefined {
  const group = layout.find(
    (item) => item.kind === "group" && item.componentIds.includes(componentId)
  );
  return group?.kind === "group" ? group.key : undefined;
}
