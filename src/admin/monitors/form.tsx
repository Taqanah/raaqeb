/**
 * The monitor form: create and edit for HTTP,
 * TCP, DNS, database, Docker and heartbeat monitors. One draft in state; every input names its
 * field and one handler updates it (draft.ts). The sections sit on the start
 * side and the test panel, or a heartbeat monitor's URL panel, on the end
 * side, as direction B draws the screen (ADR-0009); save and cancel sit in
 * the last section's footer, as on every form. A refusal marks its
 * field once the operator has tried to save or test.
 */
import { Link } from "@tanstack/react-router";
import {
  type MouseEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formWithPanel, Page } from "@/admin/shell/page.tsx";
import { useSaveFlow } from "@/admin/shell/save-flow.ts";
import { SaveFooter } from "@/admin/shell/save-footer.tsx";
import { formatUnit, type TimeOptions } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { CredentialsView } from "@/shared/schemas/credentials.ts";
import type { HeartbeatView } from "@/shared/schemas/heartbeat.ts";
import {
  databaseCheckTypes,
  defaultQueries,
  dnsRecordTypes,
  httpMethods,
  isDatabaseCheckType,
  type Monitor,
  type MonitorEventKind,
  type MonitorFormOptions,
  type MonitorInput,
  type MonitorOriginal,
  type MonitorRefusal,
  type MonitorSaveResult,
  type MonitorTestResult,
} from "@/shared/schemas/monitor.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Button, buttonVariants } from "@/shared/ui/button.tsx";
import { cn } from "@/shared/ui/cn.ts";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field.tsx";
import { TriangleAlertIcon } from "@/shared/ui/icons.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Textarea } from "@/shared/ui/textarea.tsx";
import { checkTypeLabels } from "./check-parts.tsx";
import { DockerTarget, type ListContainers } from "./docker-parts.tsx";
import {
  copyDraftOf,
  draftOf,
  type FieldErrors,
  inputOf,
  intervalChoicesMs,
  type MonitorDraft,
  newAssertion,
  tagsOf,
  typeChoiceOf,
  typeChoices,
  withChannel,
  withEvent,
  withField,
} from "./draft.ts";
import {
  ChoiceField,
  type FieldChange,
  type FieldChoice,
  type FlagChange,
  intervalLabel,
  Problem,
  Section,
  type SectionProps,
  TextField,
} from "./form-parts.tsx";
import { HeartbeatPanel, HeartbeatSection } from "./heartbeat-parts.tsx";
import {
  CaptureSection,
  RequestSection,
  type RowActions,
  SuccessRuleSection,
} from "./http-sections.tsx";
import { NotificationsSection } from "./notification-section.tsx";
import { TestPanel, type TestState } from "./test-panel.tsx";

/** What a save carries beside the input. */
export interface SaveOptions {
  /** A heartbeat monitor gets a new URL on this save. */
  readonly renewHeartbeatUrl: boolean;
}

export interface MonitorFormProps {
  /** The operator's time zone and clock, for the last heartbeat's time. */
  readonly clock: TimeOptions | undefined;
  readonly credentials: CredentialsView;
  /** A stored heartbeat monitor's URL and last heartbeat. */
  readonly heartbeat: HeartbeatView | undefined;
  /** Lists the containers of the daemon at the endpoint; answers nothing when the session check redirected. */
  readonly listContainers: ListContainers;
  /** The monitor to edit, or nothing for a new one. */
  readonly monitor: Monitor | undefined;
  /** Called with the saved monitor; a new heartbeat monitor's page shows its URL next. */
  readonly onSaved: (monitor: Monitor) => void;
  readonly options: MonitorFormOptions;
  /** The monitor a new one duplicates, whose fields the draft starts from. */
  readonly original: MonitorOriginal | undefined;
  /** Answers nothing when the session check redirected and the page is leaving. */
  readonly save: (
    input: MonitorInput,
    options: SaveOptions
  ) => Promise<MonitorSaveResult | undefined>;
  readonly test: (
    input: MonitorInput
  ) => Promise<MonitorTestResult | undefined>;
}

const saveRefusals: Readonly<Record<MonitorRefusal, MessageId>> = {
  invalid: "app_form_invalid",
  not_found: "monitor_save_not_found",
  unavailable: "monitor_unavailable",
};

const noErrors: FieldErrors = {};
const listPath = "/admin/monitors";
const formId = "monitor-form";

export function MonitorForm({
  clock,
  credentials,
  heartbeat,
  listContainers,
  monitor,
  onSaved,
  options,
  original,
  save,
  test,
}: MonitorFormProps): ReactNode {
  const { t } = useMessages();
  const [draft, setDraft] = useState(() =>
    original
      ? copyDraftOf(
          original.monitor,
          t("monitor_copy_name", { name: original.monitor.name })
        )
      : draftOf(monitor, credentials, options.channels)
  );
  // A duplicate is worth saving as it opens: its baseline is a new monitor's empty draft.
  const [start] = useState(() =>
    original ? draftOf(undefined, credentials, options.channels) : draft
  );
  const saving = useSaveFlow<MonitorDraft, MonitorRefusal>(draft, start);
  const { report } = saving;
  // Refusals show once the operator has tried to save or test, then follow every keystroke.
  const [marked, setMarked] = useState(false);
  const [testing, setTesting] = useState<TestState>({ kind: "idle" });
  const parsed = useMemo(() => inputOf(draft), [draft]);
  const errors = marked && !parsed.ok ? parsed.errors : noErrors;
  const rows = useRef(0);

  const onField: FieldChange = useCallback((event) => {
    const { name, value } = event.currentTarget;
    setDraft((current) => withField(current, name, value));
  }, []);
  const onChoice: FieldChoice = useCallback((name, value) => {
    setDraft((current) => withField(current, name, value));
  }, []);
  const onFlag: FlagChange = useCallback((name, on) => {
    setDraft((current) => ({ ...current, [name]: on }));
  }, []);
  const rowActions = useRowActions(setDraft, rows);
  const onChannel = useCallback(
    (id: string, on: boolean) => {
      setDraft((current) => withChannel(current, options.channels, id, on));
    },
    [options.channels]
  );
  const onEvent = useCallback((kind: MonitorEventKind, on: boolean) => {
    setDraft((current) => withEvent(current, kind, on));
  }, []);

  // After a refused save, the first marked field takes the focus; read after render, never in render scope.
  const { line } = saving;
  useEffect(() => {
    if (line.kind === "failed" && line.reason === "invalid") {
      document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
    }
  }, [line]);

  const onSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      setMarked(true);
      if (!parsed.ok) {
        report({ draft, kind: "failed", reason: "invalid" });
        return;
      }
      if (!report({ draft, kind: "pending" })) {
        return;
      }
      save(parsed.input, { renewHeartbeatUrl: draft.renewHeartbeatUrl }).then(
        (result) => {
          if (result?.ok) {
            report({ draft, kind: "saved" });
            onSaved(result.monitor);
            return;
          }
          report({
            draft,
            kind: "failed",
            reason: result?.reason ?? "unavailable",
          });
        },
        () => report({ draft, kind: "failed", reason: "unavailable" })
      );
    },
    [draft, onSaved, parsed, report, save]
  );

  const onTest = useCallback(() => {
    setMarked(true);
    if (!parsed.ok) {
      setTesting({ kind: "refused", reason: "invalid" });
      return;
    }
    const { input } = parsed;
    setTesting({ kind: "running" });
    test(input).then(
      (result) => {
        if (!result) {
          setTesting({ kind: "refused", reason: "unavailable" });
        } else if (result.ok) {
          const assertions =
            input.config.type === "http" ? input.config.assertions : [];
          setTesting({ assertions, kind: "done", test: result.test });
        } else {
          setTesting({ kind: "refused", reason: result.reason });
        }
      },
      () => setTesting({ kind: "refused", reason: "unavailable" })
    );
  }, [parsed, test]);

  const sections: SectionProps = { draft, errors, onChoice, onField, onFlag };
  const footer = (
    <SaveFooter
      fresh={!monitor}
      refusals={saveRefusals}
      slot="save-monitor"
      view={saving}
    >
      {/* Back where the edit started, the monitor's page; a new one goes back to the list. */}
      {monitor ? (
        <Link
          className={buttonVariants({ variant: "outline" })}
          data-slot="cancel-monitor"
          params={{ id: monitor.id }}
          to="/admin/monitors/$id"
        >
          {t("app_cancel")}
        </Link>
      ) : (
        <Link
          className={buttonVariants({ variant: "outline" })}
          data-slot="cancel-monitor"
          to={listPath}
        >
          {t("app_cancel")}
        </Link>
      )}
    </SaveFooter>
  );
  return (
    <Page
      parent={
        monitor
          ? { label: monitor.name, to: `${listPath}/${monitor.id}` }
          : { label: t("monitor_list_title"), to: listPath }
      }
      title={t(monitor ? "monitor_edit_title" : "monitor_new_title")}
    >
      {original?.hadCredentials ? (
        <Alert data-slot="credentials-not-copied" variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>
            {t(
              isDatabaseCheckType(original.monitor.config.type)
                ? "monitor_copy_connection_url"
                : "monitor_copy_credentials"
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <form
        className={cn("grid items-start gap-6", formWithPanel)}
        data-slot="monitor-form"
        id={formId}
        method="post"
        noValidate
        onSubmit={onSubmit}
      >
        <div className="flex min-w-0 flex-col gap-6">
          <BasicsSection {...sections} listContainers={listContainers} />
          {draft.type === "heartbeat" ? (
            <HeartbeatSection {...sections} />
          ) : (
            <ScheduleSection {...sections} />
          )}
          {draft.type === "http" ? (
            <>
              <SuccessRuleSection {...sections} {...rowActions} />
              <RequestSection {...sections} {...rowActions} />
              <CaptureSection {...sections} />
            </>
          ) : null}
          <OrganizationSection {...sections} options={options} />
          <NotificationsSection
            channels={options.channels}
            draft={draft}
            footer={footer}
            onChannel={onChannel}
            onEvent={onEvent}
            onField={onField}
            onFlag={onFlag}
          />
        </div>
        {draft.type === "heartbeat" ? (
          <HeartbeatPanel
            clock={clock}
            heartbeat={heartbeat}
            onFlag={onFlag}
            renew={draft.renewHeartbeatUrl}
          />
        ) : (
          <TestPanel onRun={onTest} state={testing} />
        )}
      </form>
    </Page>
  );
}

/** The row a remove button names in its `data-index`. */
function indexOf(event: MouseEvent<HTMLButtonElement>): number {
  return Number(event.currentTarget.dataset.index);
}

/** Adding and removing assertion and header rows; a new row gets a key no other row had. */
function useRowActions(
  setDraft: (update: (draft: MonitorDraft) => MonitorDraft) => void,
  rows: { current: number }
): RowActions {
  const nextKey = useCallback(() => {
    rows.current += 1;
    return `n${rows.current}`;
  }, [rows]);
  const onAddAssertion = useCallback(() => {
    const key = nextKey();
    setDraft((draft) => ({
      ...draft,
      assertions: [...draft.assertions, newAssertion("status", key)],
    }));
  }, [nextKey, setDraft]);
  const onRemoveAssertion = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const index = indexOf(event);
      setDraft((draft) => ({
        ...draft,
        assertions: draft.assertions.filter((_, at) => at !== index),
      }));
    },
    [setDraft]
  );
  const onAddHeader = useCallback(() => {
    const key = nextKey();
    setDraft((draft) => ({
      ...draft,
      headers: [
        ...draft.headers,
        { key, name: "", storedName: undefined, value: "" },
      ],
    }));
  }, [nextKey, setDraft]);
  const onRemoveHeader = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const index = indexOf(event);
      setDraft((draft) => ({
        ...draft,
        headers: draft.headers.filter((_, at) => at !== index),
      }));
    },
    [setDraft]
  );
  return { onAddAssertion, onAddHeader, onRemoveAssertion, onRemoveHeader };
}

function BasicsSection({
  draft,
  errors,
  listContainers,
  onChoice,
  onField,
}: SectionProps & { readonly listContainers: ListContainers }): ReactNode {
  const { t } = useMessages();
  return (
    <Section
      description={t("monitor_section_basics_hint")}
      slot="basics"
      title={t("monitor_section_basics")}
    >
      <TextField
        dir="auto"
        errors={errors}
        label={t("monitor_field_name")}
        name="name"
        onField={onField}
        path="name"
        value={draft.name}
      />
      <ChoiceField
        choices={typeChoices.map((choice) => ({
          label: t(
            choice === "database"
              ? "monitor_type_database"
              : checkTypeLabels[choice]
          ),
          value: choice,
        }))}
        // Six options cannot share one row on a phone: two rows of three, one radio group still.
        className="grid grid-cols-3 sm:flex"
        label={t("monitor_field_check_type")}
        name="type"
        onChoice={onChoice}
        value={typeChoiceOf(draft.type)}
      />
      {isDatabaseCheckType(draft.type) ? (
        <ChoiceField
          choices={databaseCheckTypes.map((type) => ({
            label: t(checkTypeLabels[type]),
            value: type,
          }))}
          label={t("monitor_field_database_type")}
          name="databaseType"
          onChoice={onChoice}
          value={draft.type}
        />
      ) : null}
      <Target
        draft={draft}
        errors={errors}
        listContainers={listContainers}
        onChoice={onChoice}
        onField={onField}
      />
      <Field>
        <FieldLabel htmlFor="description">
          {t("monitor_field_description")}
        </FieldLabel>
        <Textarea
          aria-invalid={errors.description ? true : undefined}
          dir="auto"
          id="description"
          name="description"
          onChange={onField}
          value={draft.description}
        />
        <Problem errors={errors} path="description" />
      </Field>
    </Section>
  );
}

/** What the check reaches, by its type. */
function Target({
  draft,
  errors,
  listContainers,
  onChoice,
  onField,
}: Pick<SectionProps, "draft" | "errors" | "onChoice" | "onField"> & {
  readonly listContainers: ListContainers;
}): ReactNode {
  const { t } = useMessages();
  const common = { errors, onField, variant: "token" } as const;
  switch (draft.type) {
    case "heartbeat":
      // A heartbeat monitor reaches nothing: its job calls it.
      return null;
    case "postgres":
    case "mysql":
    case "redis":
      return <DatabaseTarget draft={draft} errors={errors} onField={onField} />;
    case "docker":
      return (
        <DockerTarget
          draft={draft}
          errors={errors}
          listContainers={listContainers}
          onChoice={onChoice}
          onField={onField}
        />
      );
    case "tcp":
      return (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <TextField
            {...common}
            hint={t("monitor_field_host_hint")}
            label={t("monitor_field_host")}
            name="host"
            path="config.host"
            placeholder="db.example.com"
            value={draft.host}
          />
          <TextField
            {...common}
            inputMode="numeric"
            label={t("monitor_field_port")}
            name="port"
            path="config.port"
            value={draft.port}
          />
        </div>
      );
    case "dns":
      return (
        <>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <TextField
              {...common}
              label={t("monitor_field_dns_name")}
              name="dnsName"
              path="config.name"
              placeholder="example.com"
              value={draft.dnsName}
            />
            <Field>
              <FieldLabel htmlFor="recordType">
                {t("monitor_field_record_type")}
              </FieldLabel>
              <NativeSelect
                className="w-full"
                id="recordType"
                name="recordType"
                onChange={onField}
                value={draft.recordType}
              >
                {dnsRecordTypes.map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {type}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <TextField
            {...common}
            hint={t("monitor_field_expected_hint")}
            label={t("monitor_field_expected")}
            name="expected"
            path="config.expected"
            value={draft.expected}
          />
          <TextField
            {...common}
            hint={t("monitor_field_resolver_hint")}
            label={t("monitor_field_resolver")}
            name="resolver"
            path="config.resolver"
            placeholder="192.0.2.53"
            value={draft.resolver}
          />
        </>
      );
    default:
      return (
        <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <Field>
            <FieldLabel htmlFor="method">
              {t("monitor_field_method")}
            </FieldLabel>
            <NativeSelect
              className="w-full"
              id="method"
              name="method"
              onChange={onField}
              value={draft.method}
            >
              {httpMethods.map((method) => (
                <NativeSelectOption key={method} value={method}>
                  {method}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <TextField
            {...common}
            label={t("monitor_field_url")}
            name="url"
            path="config.url"
            placeholder="https://example.com/health"
            value={draft.url}
          />
        </div>
      );
  }
}

/** How a connection URL is written for each database, the password inside it. */
const connectionUrlExamples = {
  mysql: "mysql://user:password@db.example.com:3306/app?sslmode=require",
  postgres: "postgres://user:password@db.example.com:5432/app",
  redis: "redis://:password@cache.example.com:6379/0",
} as const;

/** A database monitor's connection URL, written once and never shown again, its query and the value the query must answer. */
export function DatabaseTarget({
  draft,
  errors,
  onField,
}: Pick<SectionProps, "draft" | "errors" | "onField">): ReactNode {
  const { t } = useMessages();
  if (!isDatabaseCheckType(draft.type)) {
    return null;
  }
  const { type } = draft;
  return (
    <>
      <TextField
        autoComplete="off"
        dir="ltr"
        errors={errors}
        // MySQL 8 signs in only over TLS by default, so its URL asks for it.
        hint={
          type === "mysql"
            ? `${t("monitor_field_connection_url_hint")} ${t("monitor_field_connection_url_mysql_hint")}`
            : t("monitor_field_connection_url_hint")
        }
        label={t("monitor_field_connection_url")}
        name="connectionUrl"
        onField={onField}
        path="credentials.url"
        placeholder={
          draft.storedUrlType === type
            ? t("monitor_url_kept")
            : connectionUrlExamples[type]
        }
        type="password"
        value={draft.connectionUrl}
      />
      <Field>
        <FieldLabel htmlFor="query">
          {t(
            type === "redis" ? "monitor_field_command" : "monitor_field_query"
          )}
        </FieldLabel>
        <Textarea
          aria-invalid={errors["config.query"] ? true : undefined}
          className="min-h-16 font-mono"
          dir="ltr"
          id="query"
          name="query"
          onChange={onField}
          placeholder={defaultQueries[type]}
          spellCheck={false}
          value={draft.query}
        />
        <FieldDescription>{t("monitor_field_query_hint")}</FieldDescription>
        <Problem errors={errors} path="config.query" />
      </Field>
      <TextField
        errors={errors}
        hint={t("monitor_field_answer_expected_hint")}
        label={t("monitor_field_expected")}
        name="answerExpected"
        onField={onField}
        path="config.expected"
        value={draft.answerExpected}
        variant="token"
      />
    </>
  );
}

/** An interval in the largest unit that divides it: 20 seconds, 5 minutes, 24 hours. */

function ScheduleSection({ draft, errors, onField }: SectionProps): ReactNode {
  const { locale, t } = useMessages();
  // A stored interval the list does not offer stays offered, so an edit never changes it silently.
  const intervals = intervalChoicesMs.includes(draft.intervalMs)
    ? intervalChoicesMs
    : [...intervalChoicesMs, draft.intervalMs].sort((a, b) => a - b);
  return (
    <Section
      description={t("monitor_section_schedule_hint")}
      slot="schedule"
      title={t("monitor_section_schedule")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="intervalMs">
            {t("monitor_field_interval")}
          </FieldLabel>
          <NativeSelect
            className="w-full"
            id="intervalMs"
            name="intervalMs"
            onChange={onField}
            value={String(draft.intervalMs)}
          >
            {intervals.map((ms) => (
              <NativeSelectOption key={ms} value={String(ms)}>
                {intervalLabel(locale, ms)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Problem errors={errors} path="intervalMs" />
        </Field>
        <TextField
          errors={errors}
          inputMode="numeric"
          label={t("monitor_field_timeout")}
          name="timeoutSeconds"
          onField={onField}
          path="timeoutMs"
          unit={t("monitor_unit_seconds")}
          value={draft.timeoutSeconds}
        />
        <TextField
          errors={errors}
          inputMode="numeric"
          label={t("monitor_field_retries")}
          name="retries"
          onField={onField}
          path="retries"
          value={draft.retries}
        />
      </div>
      <TextField
        errors={errors}
        hint={t("monitor_field_degraded_hint")}
        inputMode="numeric"
        label={t("monitor_field_degraded")}
        name="degradedMs"
        onField={onField}
        path="degradedMs"
        unit={t("monitor_unit_ms")}
        value={draft.degradedMs}
      />
    </Section>
  );
}

function OrganizationSection({
  draft,
  errors,
  onChoice,
  onField,
  onFlag,
  options,
}: SectionProps & { readonly options: MonitorFormOptions }): ReactNode {
  const { locale, t } = useMessages();
  const defaultDays = String(options.retentionDefaultDays);
  const changeRetention: FieldChoice = useCallback(
    (_, chosen) => {
      const own = chosen === "custom";
      onFlag("ownRetention", own);
      // The monitor's own retention starts from the install default when nothing was typed yet.
      if (own && draft.retentionDays === "") {
        onChoice("retentionDays", defaultDays);
      }
    },
    [defaultDays, draft.retentionDays, onChoice, onFlag]
  );
  const retentionChoices = [
    {
      label: t("monitor_retention_default", {
        days: formatUnit(locale, options.retentionDefaultDays, "day", "long"),
      }),
      value: "default",
    },
    { label: t("monitor_retention_custom"), value: "custom" },
  ];
  return (
    <Section slot="organization" title={t("monitor_section_organization")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          dir="auto"
          errors={errors}
          label={t("monitor_field_group")}
          list="monitor-groups"
          name="group"
          onField={onField}
          path="group"
          value={draft.group}
        />
        <TextField
          dir="auto"
          errors={errors}
          hint={t("monitor_field_tags_hint")}
          label={t("monitor_field_tags")}
          name="tags"
          onField={onField}
          path="tags"
          value={draft.tags}
        />
      </div>
      <datalist id="monitor-groups">
        {options.groups.map((group) => (
          <option key={group} value={group} />
        ))}
      </datalist>
      <TagChoices onChoice={onChoice} tags={options.tags} typed={draft.tags} />
      <ChoiceField
        choices={retentionChoices}
        label={t("monitor_field_retention")}
        name="retention"
        onChoice={changeRetention}
        value={draft.ownRetention ? "custom" : "default"}
      />
      {draft.ownRetention ? (
        <TextField
          errors={errors}
          inputMode="numeric"
          label={t("monitor_field_retention")}
          name="retentionDays"
          onField={onField}
          path="retentionDays"
          unit={t("monitor_unit_days")}
          value={draft.retentionDays}
        />
      ) : null}
    </Section>
  );
}

/** The tags other monitors carry, as switches that add or drop the name in the tags field. */
function TagChoices({
  onChoice,
  tags,
  typed,
}: {
  readonly onChoice: FieldChoice;
  readonly tags: readonly string[];
  readonly typed: string;
}): ReactNode {
  const chosen = new Set(tagsOf(typed));
  const toggle = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const tag = event.currentTarget.dataset.tag ?? "";
      const current = tagsOf(typed);
      const next = current.includes(tag)
        ? current.filter((name) => name !== tag)
        : [...current, tag];
      onChoice("tags", next.join(", "));
    },
    [onChoice, typed]
  );
  if (tags.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2" data-slot="tag-choices">
      {tags.map((tag) => (
        <Button
          aria-pressed={chosen.has(tag)}
          data-tag={tag}
          key={tag}
          onClick={toggle}
          size="sm"
          type="button"
          variant={chosen.has(tag) ? "secondary" : "outline"}
        >
          {tag}
        </Button>
      ))}
    </div>
  );
}
