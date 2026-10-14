/**
 * The component page and the new-component page: the name, the
 * description, the monitors linked to it and the status set by hand, which
 * shows only while no monitor is linked. A stored
 * component's page adds its status now, the open incidents that set it,
 * the maintenance windows in progress that put it under maintenance, the
 * status pages that show it, and delete.
 */
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  ContentField,
  useContentIn,
  useInstallLanguage,
} from "@/admin/shell/content.tsx";
import { formWithPanel, Page } from "@/admin/shell/page.tsx";
import { useRefusedFields } from "@/admin/shell/refused-fields.ts";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { CheckResult } from "@/shared/schemas/check.ts";
import type {
  Component,
  ComponentDeleteResult,
  ComponentForm as ComponentFormRead,
  ComponentInput,
  ComponentRefusal,
  ComponentSaveResult,
  LinkableMonitor,
} from "@/shared/schemas/component.ts";
import {
  componentDescriptionMaxLength,
  componentNameMaxLength,
} from "@/shared/schemas/component.ts";
import type { ContentDraft } from "@/shared/schemas/content.ts";
import { type HandSetLevel, handSetLevels } from "@/shared/schemas/status.ts";
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
import { Badge } from "@/shared/ui/badge.tsx";
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
import { TrashIcon } from "@/shared/ui/icons.tsx";
import { Input } from "@/shared/ui/input.tsx";
import { LevelChoice } from "@/shared/ui/level-choice.tsx";
import { StatusLevelBadge } from "@/shared/ui/status-level.tsx";
import { Token } from "@/shared/ui/token.tsx";
import {
  type ComponentFieldErrors,
  componentDraftOf,
  componentInputOf,
  filterMonitors,
  withMonitor,
} from "./component-draft.ts";

const refusals: Readonly<Record<ComponentRefusal, MessageId>> = {
  invalid: "app_form_invalid",
  not_found: "component_not_found",
  // A write that failed says nothing changed; "could not be read" is a read's line.
  unavailable: "app_write_unavailable",
};

const stateWords: Readonly<Record<CheckResult, MessageId>> = {
  degraded: "monitor_degraded",
  down: "monitor_status_down",
  up: "monitor_status_up",
};

const formId = "component-form";
const listPath = "/admin/components";

export interface ComponentFormProps {
  readonly form: ComponentFormRead;
  /** Called once the component is deleted. */
  readonly onRemoved?: () => void;
  /** Called with the saved component. */
  readonly onSaved: (component: Component) => void;
  /** Answers nothing when the session check redirected and the page is leaving. */
  readonly remove?: () => Promise<ComponentDeleteResult | undefined>;
  readonly save: (
    input: ComponentInput
  ) => Promise<ComponentSaveResult | undefined>;
}

export function ComponentForm({
  form,
  onRemoved,
  onSaved,
  remove,
  save,
}: ComponentFormProps): ReactNode {
  const { t } = useMessages();
  const language = useInstallLanguage();
  const text = useContentIn();
  const [draft, setDraft] = useState(() => componentDraftOf(form.component));
  const formRef = useRef<HTMLFormElement>(null);
  const judge = useCallback(
    (current: typeof draft): ComponentFieldErrors => {
      const parsed = componentInputOf(current, language);
      return parsed.ok ? {} : parsed.errors;
    },
    [language]
  );
  const { clear, errors, refuse } = useRefusedFields(formRef, draft, judge);
  const saving = useSaveFlow<typeof draft, ComponentRefusal>(draft);
  const { report } = saving;

  const onName = useCallback((name: ContentDraft) => {
    setDraft((current) => ({ ...current, name }));
  }, []);
  const onDescription = useCallback((description: ContentDraft) => {
    setDraft((current) => ({ ...current, description }));
  }, []);
  const onLink = useCallback((monitorId: string, linked: boolean) => {
    setDraft((current) => withMonitor(current, monitorId, linked));
  }, []);
  const onStatus = useCallback((value: unknown) => {
    const chosen = handSetLevels.find((level) => level === value);
    if (chosen) {
      setDraft((current) => ({ ...current, status: chosen }));
    }
  }, []);

  const onSubmit = useCallback(
    async (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = componentInputOf(draft, language);
      if (!parsed.ok) {
        refuse(parsed.errors);
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      clear();
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      const result = await save(parsed.input).catch(() => undefined);
      if (!result?.ok) {
        report({
          draft,
          kind: "failed",
          reason: result?.reason ?? "unavailable",
        });
        return;
      }
      report({ draft, kind: "saved" });
      onSaved(result.component);
    },
    [clear, draft, language, onSaved, refuse, report, save]
  );

  const title = form.component
    ? text(form.component.name)
    : t("component_new_title");
  return (
    <Page
      parent={{ label: t("component_list_title"), to: "/admin/components" }}
      title={title}
    >
      <div className={cn("grid items-start gap-6", formWithPanel)}>
        <div className="flex flex-col gap-6">
          <form
            className="flex flex-col gap-6"
            data-slot="component-form"
            id={formId}
            method="post"
            noValidate
            onSubmit={onSubmit}
            ref={formRef}
          >
            <Card>
              <CardHeader divided>
                <CardTitle>{t("component_section_details")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <ContentField
                  error={errors.name && t(errors.name)}
                  id="name"
                  label={t("component_field_name")}
                  max={componentNameMaxLength}
                  onChange={onName}
                  required={language}
                  value={draft.name}
                />
                <ContentField
                  description={t("component_field_description_hint")}
                  error={errors.description && t(errors.description)}
                  id="description"
                  label={t("component_field_description")}
                  max={componentDescriptionMaxLength}
                  multiline={2}
                  onChange={onDescription}
                  optional
                  required={language}
                  value={draft.description}
                />
              </CardContent>
            </Card>
            <MonitorLinks
              linked={draft.monitorIds}
              monitors={form.monitors}
              onLink={onLink}
            />
            <Card>
              <CardHeader divided>
                <CardTitle>{t("component_section_status")}</CardTitle>
                <CardDescription>
                  {draft.monitorIds.length === 0
                    ? t("component_status_hand_hint")
                    : t("component_status_derived_hint")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HandSetStatus
                  disabled={draft.monitorIds.length > 0}
                  onStatus={onStatus}
                  status={draft.status}
                />
              </CardContent>
              <SaveFooter
                fresh={!form.component}
                pendingLabel={t("component_saving")}
                refusals={refusals}
                saved="component_saved"
                slot="save-component"
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
          {remove ? (
            <DeleteComponent
              deletedWith={form.deletedWith}
              onRemoved={onRemoved}
              remove={remove}
            />
          ) : null}
        </div>
        {form.component ? <SidePanel form={form} /> : null}
      </div>
    </Page>
  );
}

/** The monitors to link, filtered by what the operator types. */
function MonitorLinks({
  linked,
  monitors,
  onLink,
}: {
  readonly linked: readonly string[];
  readonly monitors: readonly LinkableMonitor[];
  readonly onLink: (monitorId: string, linked: boolean) => void;
}): ReactNode {
  const { t } = useMessages();
  const [filter, setFilter] = useState("");
  const onFilter = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setFilter(event.currentTarget.value);
  }, []);
  const shown = filterMonitors(monitors, filter);
  return (
    <Card>
      <CardHeader divided>
        <CardTitle>{t("component_section_monitors")}</CardTitle>
        <CardDescription>
          {t("component_section_monitors_hint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {monitors.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("component_monitors_none")}
          </p>
        ) : (
          <>
            <Input
              aria-label={t("component_monitors_filter")}
              dir="auto"
              name="monitor-filter"
              onChange={onFilter}
              placeholder={t("component_monitors_filter")}
              type="search"
              value={filter}
            />
            {shown.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t("component_monitors_no_match")}
              </p>
            ) : (
              <ul className="flex flex-col" data-slot="component-monitors">
                {shown.map((monitor) => (
                  <MonitorRow
                    key={monitor.id}
                    linked={linked.includes(monitor.id)}
                    monitor={monitor}
                    onLink={onLink}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MonitorRow({
  linked,
  monitor,
  onLink,
}: {
  readonly linked: boolean;
  readonly monitor: LinkableMonitor;
  readonly onLink: (monitorId: string, linked: boolean) => void;
}): ReactNode {
  const { t } = useMessages();
  const toggle = useCallback(
    (checked: boolean) => onLink(monitor.id, checked),
    [monitor.id, onLink]
  );
  const id = `monitor-${monitor.id}`;
  return (
    <li
      className="flex min-h-control items-center gap-3 border-border border-b py-2 last:border-b-0"
      data-monitor={monitor.id}
      data-slot="component-monitor"
    >
      <Checkbox checked={linked} id={id} onCheckedChange={toggle} />
      <label className="flex min-w-0 flex-1 flex-col gap-0.5" htmlFor={id}>
        {/* Its own direction, but at the start like every other name. */}
        <bdi className="max-w-full self-start truncate font-medium text-sm">
          {monitor.name}
        </bdi>
        {monitor.target ? (
          <Token className="max-w-full self-start truncate">
            {monitor.target}
          </Token>
        ) : null}
      </label>
      {monitor.paused ? (
        <Badge variant="paused">{t("monitor_paused")}</Badge>
      ) : null}
      {!monitor.paused && monitor.state ? (
        <Badge variant={monitor.state}>{t(stateWords[monitor.state])}</Badge>
      ) : null}
    </li>
  );
}

/** The status set by hand, a choice of four; greyed while monitors derive it. */
function HandSetStatus({
  disabled,
  onStatus,
  status,
}: {
  readonly disabled: boolean;
  readonly onStatus: (value: unknown) => void;
  readonly status: HandSetLevel;
}): ReactNode {
  const { t } = useMessages();
  return (
    <LevelChoice
      disabled={disabled}
      label={t("component_set_by_hand")}
      levels={handSetLevels}
      name="status"
      onLevel={onStatus}
      slot="component-hand-status"
      value={status}
    />
  );
}

/** The stored component's status now and the status pages that show it. */
function SidePanel({ form }: { readonly form: ComponentFormRead }): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        {form.status ? (
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">
              {t("component_status_now")}
            </span>
            <StatusLevelBadge level={form.status} slot="component-status" />
          </div>
        ) : null}
        {form.incidents.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">
              {t("component_incidents_setting")}
            </span>
            <ul className="flex flex-col gap-1" data-slot="component-incidents">
              {form.incidents.map((incident) => (
                <li key={incident.id}>
                  <Link
                    className="text-sm underline-offset-4 hover:underline"
                    params={{ id: incident.id }}
                    to="/admin/incidents/$id"
                  >
                    <bdi>{text(incident.title)}</bdi>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {form.maintenance.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">
              {t("component_maintenance_setting")}
            </span>
            <ul
              className="flex flex-col gap-1"
              data-slot="component-maintenance"
            >
              {form.maintenance.map((window) => (
                <li key={window.id}>
                  <Link
                    className="text-sm underline-offset-4 hover:underline"
                    params={{ id: window.id }}
                    to="/admin/maintenance/$id"
                  >
                    <bdi>{text(window.title)}</bdi>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs">
            {t("component_shown_on")}
          </span>
          {form.pages.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("component_shown_on_none")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-slot="component-pages">
              {form.pages.map((page) => (
                <li key={page.id}>
                  <Link
                    className="text-sm underline-offset-4 hover:underline"
                    params={{ id: page.id }}
                    to="/admin/pages/$id"
                  >
                    <bdi>{text(page.title)}</bdi>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Delete, after the operator confirms, naming the incidents and windows that go with it. */
function DeleteComponent({
  deletedWith,
  onRemoved,
  remove,
}: {
  readonly deletedWith: ComponentFormRead["deletedWith"];
  readonly onRemoved: (() => void) | undefined;
  readonly remove: () => Promise<ComponentDeleteResult | undefined>;
}): ReactNode {
  const { t } = useMessages();
  const text = useContentIn();
  const groups = [
    {
      label: t("incident_list_title"),
      records: deletedWith.incidents,
      slot: "deleted-incidents",
    },
    {
      label: t("maintenance_list_title"),
      records: deletedWith.maintenance,
      slot: "deleted-maintenance",
    },
  ].filter((group) => group.records.length > 0);
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<ComponentRefusal | undefined>();
  const ask = useCallback(() => setOpen(true), []);
  const confirm = useCallback(async () => {
    const result = await remove().catch(() => undefined);
    if (result?.ok) {
      onRemoved?.();
      return;
    }
    setRefused(result?.ok === false ? result.reason : "unavailable");
  }, [onRemoved, remove]);
  return (
    <div className="flex flex-col gap-2">
      <Button
        className="self-start"
        data-slot="delete-component"
        onClick={ask}
        type="button"
        variant="destructive-outline"
      >
        <TrashIcon />
        {t("component_delete")}
      </Button>
      {refused ? (
        <p className="text-destructive text-sm" role="alert">
          {t(refusals[refused])}
        </p>
      ) : null}
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("component_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("component_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {groups.length > 0 ? (
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-center sm:text-start">
                {t("component_delete_takes")}
              </p>
              <div className="flex max-h-48 flex-col gap-3 overflow-y-auto rounded-lg border p-3">
                {groups.map((group) => (
                  <div className="flex flex-col gap-1" key={group.slot}>
                    <span className="text-muted-foreground text-xs">
                      {group.label}
                    </span>
                    <ul className="flex flex-col gap-1" data-slot={group.slot}>
                      {group.records.map((record) => (
                        <li data-record={record.id} key={record.id}>
                          <bdi>{text(record.title)}</bdi>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("app_cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="confirm-delete"
              onClick={confirm}
              variant="destructive"
            >
              {t("component_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
