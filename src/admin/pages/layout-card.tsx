/**
 * The editor's components card: the
 * ordered list of what visitors see, groups and ungrouped components in one
 * top-level order, each group one level deep with its aggregate status.
 * Buttons move an entry up or down among its neighbours, a menu moves a
 * component into a group or out of one, and the add menu places a component
 * at the end. No drag and drop: it fails on touch and on the keyboard.
 */
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import {
  ContentInputs,
  ContentText,
  useContentIn,
} from "@/admin/shell/content.tsx";
import { worstStatus } from "@/shared/domain/status.ts";
import type { Locale } from "@/shared/i18n/locale.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { type ContentDraft, contentDraftOf } from "@/shared/schemas/content.ts";
import {
  groupNameMaxLength,
  type PlaceableComponent,
} from "@/shared/schemas/page.ts";
import type { StatusLevel } from "@/shared/schemas/status.ts";
import { Button } from "@/shared/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { FieldError } from "@/shared/ui/field.tsx";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  XIcon,
} from "@/shared/ui/icons.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import {
  addComponent,
  addGroup,
  type DraftItem,
  groupOf,
  type LayoutEntry,
  moveComponentTo,
  moveEntry,
  type PageFieldErrors,
  placedComponents,
  removeComponent,
  removeGroup,
  renameGroup,
} from "./page-draft.ts";

/** What every row needs: the layout, the install's components and a way to replace the layout. */
interface RowContext {
  readonly components: ReadonlyMap<string, PlaceableComponent>;
  readonly layout: readonly DraftItem[];
  /** The page language, whose text a group's name needs. */
  readonly locale: Locale;
  readonly onLayout: (layout: DraftItem[]) => void;
}

/** A group's name with no text in any locale. */
const emptyName = contentDraftOf(undefined);

/** The value the move-to menu gives the top level. */
const topLevel = "";

export function LayoutCard({
  components,
  errors,
  layout,
  locale,
  onLayout,
}: {
  readonly components: readonly PlaceableComponent[];
  readonly errors: PageFieldErrors;
  readonly layout: readonly DraftItem[];
  readonly locale: Locale;
  readonly onLayout: (layout: DraftItem[]) => void;
}): ReactNode {
  const { locale: operator, t } = useMessages();
  const text = useContentIn();
  const byId = new Map(components.map((each) => [each.id, each]));
  const context: RowContext = { components: byId, layout, locale, onLayout };
  const placed = placedComponents(layout);
  const unplaced = components.filter((each) => !placed.includes(each.id));
  const statuses = placed.flatMap((id) => {
    const status = byId.get(id)?.status;
    return status ? [status] : [];
  });

  const onAdd = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.currentTarget;
      if (value !== "") {
        onLayout(addComponent(layout, value));
      }
    },
    [layout, onLayout]
  );
  const onAddGroup = useCallback(() => {
    // The new name in the operator's own language; the page language's is asked for on save when they differ.
    onLayout(
      addGroup(layout, { ...emptyName, [operator]: t("page_group_new") })
    );
  }, [layout, onLayout, operator, t]);

  return (
    <Card data-section="page-components">
      <CardHeader divided>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{t("page_section_components")}</CardTitle>
            <CardDescription>
              {t("page_section_components_hint")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              {t("page_level_now")}
            </span>
            <StatusLevelBadge level={worstStatus(statuses)} slot="page-level" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {layout.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("page_components_empty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y" data-slot="page-layout">
            {layout.map((item) =>
              item.kind === "component" ? (
                <ComponentRow
                  componentId={item.componentId}
                  context={context}
                  key={item.componentId}
                />
              ) : (
                <GroupRow
                  context={context}
                  error={errors[`layout.${item.key}`]}
                  group={item}
                  key={item.key}
                />
              )
            )}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {components.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("page_no_components")}{" "}
              <Link
                className="underline underline-offset-4"
                to="/admin/components/new"
              >
                {t("component_add")}
              </Link>
            </p>
          ) : null}
          {components.length > 0 && unplaced.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("page_all_placed")}
            </p>
          ) : null}
          {unplaced.length > 0 ? (
            <NativeSelect
              aria-label={t("page_add_component")}
              data-slot="add-page-component"
              name="add-component"
              onChange={onAdd}
              value=""
            >
              <NativeSelectOption value="">
                {t("page_add_component")}
              </NativeSelectOption>
              {unplaced.map((each) => (
                <NativeSelectOption key={each.id} value={each.id}>
                  {text(each.name)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          <Button
            data-slot="add-page-group"
            onClick={onAddGroup}
            type="button"
            variant="outline"
          >
            <PlusIcon />
            {t("page_add_group")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Up and down for one entry; each rests at its edge, still focusable, so a press there changes nothing and the focus stays. */
function MoveButtons({
  context,
  entry,
  first,
  last,
}: {
  readonly context: RowContext;
  readonly entry: LayoutEntry;
  readonly first: boolean;
  readonly last: boolean;
}): ReactNode {
  const { t } = useMessages();
  const { layout, onLayout } = context;
  const up = useCallback(
    () => onLayout(moveEntry(layout, entry, -1)),
    [entry, layout, onLayout]
  );
  const down = useCallback(
    () => onLayout(moveEntry(layout, entry, 1)),
    [entry, layout, onLayout]
  );
  return (
    <>
      <Button
        aria-disabled={first}
        aria-label={t("page_move_up")}
        data-slot="move-up"
        onClick={up}
        size="icon"
        type="button"
        variant="ghost"
      >
        <ChevronUpIcon />
      </Button>
      <Button
        aria-disabled={last}
        aria-label={t("page_move_down")}
        data-slot="move-down"
        onClick={down}
        size="icon"
        type="button"
        variant="ghost"
      >
        <ChevronDownIcon />
      </Button>
    </>
  );
}

/** Where a component sits among its neighbours: inside its group or at the top level. */
function edgesOf(
  layout: readonly DraftItem[],
  entry: LayoutEntry
): { first: boolean; last: boolean } {
  if ("componentId" in entry) {
    const group = layout.find(
      (item) =>
        item.kind === "group" && item.componentIds.includes(entry.componentId)
    );
    if (group?.kind === "group") {
      const index = group.componentIds.indexOf(entry.componentId);
      return {
        first: index === 0,
        last: index === group.componentIds.length - 1,
      };
    }
  }
  const index = layout.findIndex((item) =>
    "groupKey" in entry
      ? item.kind === "group" && item.key === entry.groupKey
      : item.kind === "component" && item.componentId === entry.componentId
  );
  return { first: index === 0, last: index === layout.length - 1 };
}

function ComponentRow({
  componentId,
  context,
}: {
  readonly componentId: string;
  readonly context: RowContext;
}): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  const { components, layout, onLayout } = context;
  const component = components.get(componentId);
  const groups = layout.flatMap((item) =>
    item.kind === "group" ? [item] : []
  );
  const entry: LayoutEntry = { componentId };
  const onMove = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.currentTarget;
      onLayout(
        moveComponentTo(
          layout,
          componentId,
          value === topLevel ? undefined : value
        )
      );
    },
    [componentId, layout, onLayout]
  );
  const onRemove = useCallback(
    () => onLayout(removeComponent(layout, componentId)),
    [componentId, layout, onLayout]
  );
  if (!component) {
    return null;
  }
  return (
    <li
      className="flex min-h-control flex-wrap items-center gap-2 py-1.5"
      data-component={componentId}
      data-slot="page-item"
    >
      {/* On a narrow screen the name takes its own line and the controls wrap under it. */}
      {/* The span sits the name on the page's start side; the bdi cuts it in the name's own direction, at its end. */}
      <span className="flex min-w-0 basis-full font-medium text-sm sm:flex-1 sm:basis-auto">
        <ContentText className="truncate" content={component.name} />
      </span>
      <StatusLevelBadge level={component.status} />
      {groups.length > 0 ? (
        <NativeSelect
          aria-label={t("page_move_to")}
          data-slot="move-to"
          onChange={onMove}
          value={groupOf(layout, componentId) ?? topLevel}
        >
          <NativeSelectOption value={topLevel}>
            {t("page_top_level")}
          </NativeSelectOption>
          {groups.map((group) => (
            <NativeSelectOption key={group.key} value={group.key}>
              {text(group.name)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      <MoveButtons
        context={context}
        entry={entry}
        {...edgesOf(layout, entry)}
      />
      <Button
        aria-label={t("page_remove_component")}
        data-slot="remove-component"
        onClick={onRemove}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </li>
  );
}

function GroupRow({
  context,
  error,
  group,
}: {
  readonly context: RowContext;
  readonly error: string | undefined;
  readonly group: Extract<DraftItem, { kind: "group" }>;
}): ReactNode {
  const { t } = useMessages();
  const { components, layout, locale, onLayout } = context;
  const entry: LayoutEntry = { groupKey: group.key };
  const statuses = group.componentIds.flatMap((id): StatusLevel[] => {
    const status = components.get(id)?.status;
    return status ? [status] : [];
  });
  const onRename = useCallback(
    (name: ContentDraft) => onLayout(renameGroup(layout, group.key, name)),
    [group.key, layout, onLayout]
  );
  const onRemove = useCallback(
    () => onLayout(removeGroup(layout, group.key)),
    [group.key, layout, onLayout]
  );
  return (
    <li
      className="flex flex-col gap-2 py-2"
      data-group={group.key}
      data-slot="page-group"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ContentInputs
          className="basis-full sm:flex-1 sm:basis-auto"
          id={`group-${group.key}`}
          invalid={error !== undefined}
          label={t("page_group_name")}
          max={groupNameMaxLength}
          onChange={onRename}
          required={locale}
          value={group.name}
        />
        {/* An empty group is not shown to visitors, so it has no status either. */}
        {statuses.length > 0 ? (
          <StatusLevelBadge level={worstStatus(statuses)} slot="group-level" />
        ) : null}
        <MoveButtons
          context={context}
          entry={entry}
          {...edgesOf(layout, entry)}
        />
        <Button
          aria-label={t("page_remove_group")}
          data-slot="remove-group"
          onClick={onRemove}
          size="icon"
          title={t("page_remove_group_hint")}
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      {error ? <FieldError>{t("page_refused_group")}</FieldError> : null}
      {group.componentIds.length === 0 ? (
        <p className="px-1 text-muted-foreground text-xs">
          {t("page_group_empty")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y border-s ps-4">
          {group.componentIds.map((componentId) => (
            <ComponentRow
              componentId={componentId}
              context={context}
              key={componentId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
