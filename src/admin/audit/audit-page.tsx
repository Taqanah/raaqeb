/**
 * The audit log page (CONTEXT.md "Audit entry"), an owner's or admin's:
 * who did what to what, from where and when, newest first, filtered by
 * account, by kind, to refused attempts and to days between two dates,
 * fifty at a time with the way to older ones.
 */
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { TimeField } from "@/admin/maintenance/time-field.tsx";
import { Page } from "@/admin/shell/page.tsx";
import {
  type AuditTarget,
  type AuditVerb,
  actionParts,
  auditTargets,
} from "@/shared/domain/audit.ts";
import {
  dayMs,
  formatDateTime,
  formatUnit,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import { wallTime } from "@/shared/i18n/timezone.ts";
import type { AuditEntry, AuditView } from "@/shared/schemas/audit.ts";
import { retentionDefaultDays } from "@/shared/schemas/monitor.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Button } from "@/shared/ui/button.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import { Field, FieldLabel } from "@/shared/ui/field.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table.tsx";
import { Token } from "@/shared/ui/token.tsx";

/** What the address asks the log for (`/admin/audit?actor=&kind=&refused=&from=&to=&before=`); an absent one means no filter. */
export interface AuditSearch {
  readonly actor?: string;
  readonly before?: number;
  /** The first day, `yyyy-mm-dd` in the operator's zone. */
  readonly from?: string;
  readonly kind?: string;
  readonly refused?: true;
  /** The last day, inclusive. */
  readonly to?: string;
}

export interface AuditPageProps {
  readonly clock: TimeOptions;
  /** The server's read time: the day fields start from its day. */
  readonly now: number;
  /** Changes the filters given and keeps the others; any change but `before` reads from the newest entry again. */
  readonly onFilter: (change: AuditSearch) => void;
  readonly search: AuditSearch;
  readonly view: AuditView | undefined;
}

const targetWords: Readonly<Record<AuditTarget, MessageId>> = {
  account: "audit_target_account",
  api_key: "audit_target_api_key",
  appearance: "audit_target_appearance",
  auth_mail: "audit_target_auth_mail",
  channel: "audit_target_channel",
  component: "audit_target_component",
  incident: "audit_target_incident",
  invitation: "audit_target_invitation",
  maintenance: "audit_target_maintenance",
  member: "audit_target_member",
  metrics: "audit_target_metrics",
  monitor: "audit_target_monitor",
  notifications: "audit_target_notifications",
  outage: "audit_target_outage",
  ownership: "audit_target_ownership",
  page: "audit_target_page",
  password: "audit_target_password",
  probe: "audit_target_probe",
  second_step: "audit_target_second_step",
  series: "audit_target_series",
  session: "audit_target_session",
  settings: "audit_target_settings",
  sign_in: "audit_target_sign_in",
  sso: "audit_target_sso",
  storage: "audit_target_storage",
  subscriber: "audit_target_subscriber",
  transfer: "audit_target_transfer",
};

const verbWords: Readonly<Record<AuditVerb, MessageId>> = {
  acknowledge: "audit_verb_acknowledge",
  change: "audit_verb_change",
  check: "audit_verb_check",
  create: "audit_verb_create",
  deactivate: "audit_verb_deactivate",
  delete: "audit_verb_delete",
  end: "audit_verb_end",
  export: "audit_verb_export",
  import: "audit_verb_import",
  pause: "audit_verb_pause",
  post: "audit_verb_post",
  reactivate: "audit_verb_reactivate",
  refuse: "audit_verb_refuse",
  reset: "audit_verb_reset",
  resume: "audit_verb_resume",
  revoke: "audit_verb_revoke",
  send: "audit_verb_send",
  succeed: "audit_verb_succeed",
  upload: "audit_verb_upload",
};

const dayText = /^\d{4}-\d{2}-\d{2}$/;

export function AuditPage({
  clock,
  now,
  onFilter,
  search,
  view,
}: AuditPageProps): ReactNode {
  const { locale, t } = useMessages();
  const onActor = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onFilter({ actor: event.currentTarget.value || undefined }),
    [onFilter]
  );
  const onKind = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onFilter({ kind: event.currentTarget.value || undefined }),
    [onFilter]
  );
  const onRefused = useCallback(
    (checked: boolean) => onFilter({ refused: checked ? true : undefined }),
    [onFilter]
  );
  const today = wallTime(now, clock.timeZone).slice(0, 10);
  // Between two dates starts at the last seven days, today included.
  const weekAgo = new Date(Date.parse(today) - 6 * dayMs)
    .toISOString()
    .slice(0, 10);
  const onDates = useCallback(
    (checked: boolean) =>
      onFilter(
        checked
          ? { from: weekAgo, to: today }
          : { from: undefined, to: undefined }
      ),
    [onFilter, today, weekAgo]
  );
  const onDay = useCallback(
    (name: "from" | "to", value: string) => {
      const day = value.slice(0, 10);
      // A cleared date field keeps the day it had.
      if (dayText.test(day)) {
        onFilter({ [name]: day });
      }
    },
    [onFilter]
  );
  const last = view?.entries.at(-1);
  const older = useCallback(() => {
    onFilter({ before: last?.at });
  }, [last?.at, onFilter]);
  const dates = search.from !== undefined || search.to !== undefined;
  if (!view) {
    return (
      <Page title={t("audit_title")}>
        <Alert variant="destructive">
          <AlertDescription>{t("audit_unavailable")}</AlertDescription>
        </Alert>
      </Page>
    );
  }
  return (
    <Page title={t("audit_title")}>
      <p className="text-muted-foreground text-sm">
        {t("audit_intro", {
          days: formatUnit(locale, retentionDefaultDays, "day", "long"),
        })}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field className="sm:w-64">
          <FieldLabel htmlFor="audit-actor">
            {t("audit_filter_actor")}
          </FieldLabel>
          <NativeSelect
            id="audit-actor"
            name="actor"
            onChange={onActor}
            value={search.actor ?? ""}
          >
            <NativeSelectOption value="">
              {t("audit_filter_all")}
            </NativeSelectOption>
            {view.actors.map((one) => (
              <NativeSelectOption key={one.id} value={one.id}>
                {one.email}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="sm:w-64">
          <FieldLabel htmlFor="audit-kind">{t("audit_filter_kind")}</FieldLabel>
          <NativeSelect
            id="audit-kind"
            name="kind"
            onChange={onKind}
            value={search.kind ?? ""}
          >
            <NativeSelectOption value="">
              {t("audit_filter_all")}
            </NativeSelectOption>
            {auditTargets.map((target) => (
              <NativeSelectOption key={target} value={target}>
                {t(targetWords[target])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
        <Field className="w-auto" orientation="horizontal">
          <Checkbox
            checked={search.refused === true}
            id="audit-refused"
            name="refused"
            onCheckedChange={onRefused}
          />
          <FieldLabel htmlFor="audit-refused">
            {t("audit_filter_refused")}
          </FieldLabel>
        </Field>
        <Field className="w-auto" orientation="horizontal">
          <Checkbox
            checked={dates}
            id="audit-dates"
            name="dates"
            onCheckedChange={onDates}
          />
          <FieldLabel htmlFor="audit-dates">
            {t("audit_filter_dates")}
          </FieldLabel>
        </Field>
      </div>
      {dates ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="sm:min-w-64">
            <TimeField
              clock={clock}
              label={t("audit_filter_from")}
              name="from"
              now={now}
              onChange={onDay}
              timeless
              value={`${search.from ?? weekAgo}T00:00`}
            />
          </div>
          <div className="sm:min-w-64">
            <TimeField
              clock={clock}
              label={t("audit_filter_to")}
              name="to"
              now={now}
              onChange={onDay}
              timeless
              value={`${search.to ?? today}T00:00`}
            />
          </div>
        </div>
      ) : null}
      {view.entries.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-slot="audit-empty">
          {t("audit_empty")}
        </p>
      ) : (
        <Table data-slot="audit-entries" framed stacked>
          <TableHeader>
            <TableRow>
              <TableHead>{t("audit_column_action")}</TableHead>
              <TableHead>{t("audit_column_actor")}</TableHead>
              <TableHead>{t("audit_column_target")}</TableHead>
              <TableHead>{t("audit_column_address")}</TableHead>
              <TableHead>{t("audit_column_time")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.entries.map((entry) => (
              <EntryRow clock={clock} entry={entry} key={entry.id} />
            ))}
          </TableBody>
        </Table>
      )}
      {view.more ? (
        <Button
          className="self-start"
          data-slot="audit-older"
          onClick={older}
          type="button"
          variant="outline"
        >
          {t("audit_older")}
        </Button>
      ) : null}
    </Page>
  );
}

function EntryRow({
  clock,
  entry,
}: {
  readonly clock: TimeOptions;
  readonly entry: AuditEntry;
}): ReactNode {
  const { locale, t } = useMessages();
  const parts = actionParts(entry.action);
  const detail = Object.entries(entry.detail);
  return (
    <TableRow data-action={entry.action} data-slot="audit-entry">
      <TableCell className="min-w-56 max-w-md whitespace-normal">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {parts
              ? t("audit_action", {
                  target: t(targetWords[parts.target]),
                  verb: t(verbWords[parts.verb]),
                })
              : entry.action}
          </span>
          {detail.length > 0 ? (
            <Token
              className="wrap-anywhere block whitespace-normal text-xs"
              dir="ltr"
            >
              {detail
                .map(([name, value]) => `${name}=${String(value)}`)
                .join(" ")}
            </Token>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {entry.actorEmail ? (
          <Token dir="ltr">{entry.actorEmail}</Token>
        ) : (
          <span className="text-muted-foreground">{t("audit_nobody")}</span>
        )}
      </TableCell>
      <TableCell>
        {/* A bulk change names many ids; they wrap rather than pushing the address and time past the frame. */}
        {entry.targetId ? (
          <Token
            className="wrap-anywhere inline-block max-w-64 whitespace-normal"
            dir="ltr"
          >
            {entry.targetId}
          </Token>
        ) : null}
      </TableCell>
      <TableCell>
        {entry.address ? <Token dir="ltr">{entry.address}</Token> : null}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {formatDateTime(locale, entry.at, clock)}
      </TableCell>
    </TableRow>
  );
}
