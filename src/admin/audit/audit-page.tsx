/**
 * The audit log page (CONTEXT.md "Audit entry"), an owner's or admin's:
 * who did what to what, from where and when, newest first, filtered by
 * account and by kind, fifty at a time with the way to older ones.
 */
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { Page } from "@/admin/shell/page.tsx";
import {
  type AuditTarget,
  type AuditVerb,
  actionParts,
  auditTargets,
} from "@/shared/domain/audit.ts";
import { formatDateTime, type TimeOptions } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type { AuditEntry, AuditView } from "@/shared/schemas/audit.ts";
import { Alert, AlertDescription } from "@/shared/ui/alert.tsx";
import { Button } from "@/shared/ui/button.tsx";
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

export interface AuditPageProps {
  readonly actor: string | undefined;
  readonly clock: TimeOptions;
  readonly kind: string | undefined;
  readonly onFilter: (filter: {
    readonly actor?: string;
    readonly before?: number;
    readonly kind?: string;
  }) => void;
  readonly view: AuditView | undefined;
}

const targetWords: Readonly<Record<AuditTarget, MessageId>> = {
  account: "audit_target_account",
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

export function AuditPage({
  actor,
  clock,
  kind,
  onFilter,
  view,
}: AuditPageProps): ReactNode {
  const { t } = useMessages();
  const onActor = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onFilter({ actor: event.currentTarget.value || undefined, kind });
    },
    [kind, onFilter]
  );
  const onKind = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onFilter({ actor, kind: event.currentTarget.value || undefined });
    },
    [actor, onFilter]
  );
  const last = view?.entries.at(-1);
  const older = useCallback(() => {
    onFilter({ actor, before: last?.at, kind });
  }, [actor, kind, last?.at, onFilter]);
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
      <p className="text-muted-foreground text-sm">{t("audit_intro")}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field className="sm:w-64">
          <FieldLabel htmlFor="audit-actor">
            {t("audit_filter_actor")}
          </FieldLabel>
          <NativeSelect
            id="audit-actor"
            name="actor"
            onChange={onActor}
            value={actor ?? ""}
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
            value={kind ?? ""}
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
        {entry.targetId ? (
          <Token className="wrap-anywhere" dir="ltr">
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
