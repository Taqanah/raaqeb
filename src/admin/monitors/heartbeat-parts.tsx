/**
 * A heartbeat monitor's part of the form: the schedule, "every N" or a cron expression, and the grace period,
 * each amount typed with its unit; and in place of "test now", the panel
 * with the monitor's unique URL, the lines a job runs when it succeeds and
 * when it fails, its latest heartbeats with what each reported, and the
 * switch that gives the monitor a new URL on save. The URL, the source
 * address and the exit code are machine tokens, isolated LTR; a failure's
 * message is the job's own words, text that follows its own direction.
 */
import { type ReactNode, useCallback, useRef } from "react";
import {
  formatDateTimeWithZone,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type Heartbeat,
  type HeartbeatView,
  heartbeatFailSuffix,
} from "@/shared/schemas/heartbeat.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card.tsx";
import { CopyButton } from "@/shared/ui/copy-button.tsx";
import { Field, FieldLabel } from "@/shared/ui/field.tsx";
import { Segmented, SegmentedItem } from "@/shared/ui/segmented.tsx";
import { Token } from "@/shared/ui/token.tsx";
import { curlLine, type DurationUnit, durationUnits } from "./draft.ts";
import {
  ChoiceField,
  type FlagChange,
  FlagField,
  Section,
  type SectionProps,
  TextField,
} from "./form-parts.tsx";

const unitWords: Readonly<Record<DurationUnit, MessageId>> = {
  days: "monitor_duration_days",
  hours: "monitor_duration_hours",
  minutes: "monitor_duration_minutes",
  seconds: "monitor_duration_seconds",
};

/** An amount and its unit side by side; the refusal sits under the amount. */
function DurationField({
  amount,
  errors,
  label,
  hint,
  name,
  onChoice,
  onField,
  path,
  unit,
}: Pick<SectionProps, "errors" | "onChoice" | "onField"> & {
  readonly amount: string;
  readonly hint?: string;
  readonly label: string;
  readonly name: "every" | "grace";
  readonly path: string;
  readonly unit: DurationUnit;
}): ReactNode {
  const { t } = useMessages();
  const unitName = `${name}Unit`;
  const onUnit = useCallback(
    (value: unknown) => onChoice(unitName, String(value)),
    [onChoice, unitName]
  );
  return (
    <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <TextField
        errors={errors}
        hint={hint}
        inputMode="numeric"
        label={label}
        name={name}
        onField={onField}
        path={path}
        value={amount}
      />
      <Field>
        <FieldLabel id={`${unitName}-label`}>
          {t("monitor_field_unit")}
        </FieldLabel>
        {/* Four units: two rows of two on a phone. */}
        <Segmented
          aria-labelledby={`${unitName}-label`}
          className="max-sm:grid max-sm:grid-cols-2"
          data-name={unitName}
          name={unitName}
          onValueChange={onUnit}
          value={unit}
        >
          {durationUnits.map((each) => (
            <SegmentedItem key={each} value={each}>
              {t(unitWords[each])}
            </SegmentedItem>
          ))}
        </Segmented>
      </Field>
    </div>
  );
}

export function HeartbeatSection({
  draft,
  errors,
  onChoice,
  onField,
}: SectionProps): ReactNode {
  const { t } = useMessages();
  return (
    <Section
      description={t("monitor_section_heartbeat_hint")}
      slot="heartbeat"
      title={t("monitor_section_heartbeat")}
    >
      <ChoiceField
        choices={[
          { label: t("monitor_schedule_every"), value: "every" },
          { label: t("monitor_schedule_cron"), value: "cron" },
        ]}
        label={t("monitor_field_schedule_kind")}
        name="scheduleKind"
        onChoice={onChoice}
        value={draft.scheduleKind}
      />
      {draft.scheduleKind === "cron" ? (
        <TextField
          errors={errors}
          hint={t("monitor_field_cron_hint")}
          label={t("monitor_field_cron")}
          name="cron"
          onField={onField}
          path="config.schedule.expression"
          placeholder="30 2 * * *"
          value={draft.cron}
          variant="token"
        />
      ) : (
        <DurationField
          amount={draft.every}
          errors={errors}
          label={t("monitor_field_every")}
          name="every"
          onChoice={onChoice}
          onField={onField}
          path="config.schedule.everyMs"
          unit={draft.everyUnit}
        />
      )}
      <DurationField
        amount={draft.grace}
        errors={errors}
        hint={t("monitor_field_grace_hint")}
        label={t("monitor_field_grace")}
        name="grace"
        onChoice={onChoice}
        onField={onField}
        path="config.graceMs"
        unit={draft.graceUnit}
      />
    </Section>
  );
}

/** One heartbeat of the list: when it arrived, whether the job succeeded or failed, and for a failure its exit code and message; the source address under them. */
function HeartbeatRow({
  clock,
  heartbeat,
  slot,
}: {
  readonly clock: TimeOptions;
  readonly heartbeat: Heartbeat;
  readonly slot?: string;
}): ReactNode {
  const { locale, t } = useMessages();
  const { failure } = heartbeat;
  return (
    <li
      className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
      data-failed={failure ? "" : undefined}
      data-slot={slot}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {formatDateTimeWithZone(locale, heartbeat.arrivedAt, clock)}
        </span>
        <Badge variant={failure ? "down" : "up"}>
          {failure
            ? t("monitor_heartbeat_status_failed")
            : t("monitor_heartbeat_status_ok")}
        </Badge>
        {failure?.exitCode === undefined ? null : (
          <span className="flex items-center gap-1 text-muted-foreground">
            {t("monitor_heartbeat_exit_code")}
            <Token>{String(failure.exitCode)}</Token>
          </span>
        )}
        {heartbeat.sourceIp ? (
          <Token className="text-muted-foreground">{heartbeat.sourceIp}</Token>
        ) : null}
      </div>
      {failure?.message ? (
        // The job's own words, in whichever language it wrote them: the direction follows the text, not the page.
        <p className="wrap-anywhere" dir="auto">
          {failure.message}
        </p>
      ) : null}
    </li>
  );
}

/** The panel beside a heartbeat monitor's form and on its detail page: its URL once saved, the lines a job runs, the latest heartbeats, and on the form the switch for a new URL. */
export function HeartbeatPanel({
  clock,
  heartbeat,
  onFlag,
  renew,
}: {
  readonly clock: TimeOptions | undefined;
  readonly heartbeat: HeartbeatView | undefined;
  /** The form's switch for a new URL; the detail page has none. */
  readonly onFlag?: FlagChange;
  readonly renew?: boolean;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Card className="lg:sticky lg:top-20" data-slot="heartbeat-panel">
      <CardHeader divided>
        <CardTitle>{t("monitor_heartbeat_title")}</CardTitle>
        <CardDescription>{t("monitor_heartbeat_hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {heartbeat ? (
          <>
            {heartbeat.url === undefined ? (
              <p
                className="text-muted-foreground text-sm"
                data-slot="heartbeat-url-withheld"
              >
                {t("monitor_heartbeat_withheld")}
              </p>
            ) : (
              <>
                <Copyable
                  copy="heartbeat-url"
                  slot="heartbeat-url"
                  text={heartbeat.url}
                />
                <div className="flex flex-col gap-1.5 text-muted-foreground text-sm">
                  <span>{t("monitor_heartbeat_command")}</span>
                  <Copyable
                    copy="heartbeat-command"
                    text={curlLine(heartbeat.url)}
                  />
                </div>
                <div className="flex flex-col gap-1.5 text-muted-foreground text-sm">
                  <span>{t("monitor_heartbeat_fail_command")}</span>
                  <Copyable
                    copy="heartbeat-fail-command"
                    text={curlLine(`${heartbeat.url}${heartbeatFailSuffix}`)}
                  />
                </div>
              </>
            )}
            {heartbeat.recent.length > 0 && clock ? (
              <div className="flex flex-col gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t("monitor_heartbeat_recent")}
                </span>
                <ul className="flex flex-col divide-y" data-slot="heartbeats">
                  {heartbeat.recent.map((each, index) => (
                    <HeartbeatRow
                      clock={clock}
                      heartbeat={each}
                      key={each.arrivedAt}
                      slot={index === 0 ? "last-heartbeat" : undefined}
                    />
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("monitor_heartbeat_none")}
              </p>
            )}
            {onFlag ? (
              <FlagField
                checked={renew ?? false}
                hint={t("monitor_heartbeat_renew_hint")}
                label={t("monitor_heartbeat_renew")}
                name="renewHeartbeatUrl"
                onFlag={onFlag}
                slot="renew-heartbeat-url"
              />
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("monitor_heartbeat_after_save")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** A machine token with its copy button beside it; a line with spaces breaks at them first, so a URL in it stays whole where it fits. */
function Copyable({
  copy,
  slot,
  text,
}: {
  /** The button's `data-copy`, which the browser tests press. */
  readonly copy: string;
  readonly slot?: string;
  readonly text: string;
}): ReactNode {
  const token = useRef<HTMLElement>(null);
  return (
    <div className="flex items-start gap-2">
      <Token
        className="wrap-anywhere min-w-0 flex-1 py-1"
        data-slot={slot}
        ref={token}
      >
        {text}
      </Token>
      <CopyButton data-copy={copy} size="sm" target={token} text={text} />
    </div>
  );
}
