/**
 * The monitor form's notifications: the notification channels the monitor selects, the monitor events
 * that notify them, and the reminder while it stays down. A new monitor
 * starts with the channels that apply to new monitors and all five events
 * (draft.ts `draftOf`). An event that cannot happen for the monitor as the
 * form stands is greyed with the reason, or hidden where the check type
 * never raises it. With no channel yet, the section links to the
 * new-channel page.
 */
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { formatUnit, normalizeDigits } from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import {
  type ChannelChoice,
  channelDeclarations,
} from "@/shared/schemas/channel.ts";
import {
  type MonitorEventKind,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { Badge } from "@/shared/ui/badge.tsx";
import { buttonVariants } from "@/shared/ui/button.tsx";
import { Checkbox } from "@/shared/ui/checkbox.tsx";
import { cn } from "@/shared/ui/cn.ts";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/field.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/shared/ui/native-select.tsx";
import { Switch } from "@/shared/ui/switch.tsx";
import { isHttps, type MonitorDraft, reminderChoicesMs } from "./draft.ts";
import {
  type FieldChange,
  type FlagChange,
  FlagField,
  intervalLabel,
  Section,
} from "./form-parts.tsx";

/** Each monitor event's label, which the recent sends reuse. */
export const eventLabels: Readonly<Record<MonitorEventKind, MessageId>> = {
  certificate_expiring: "monitor_event_certificate_expiring",
  degraded_ended: "monitor_event_degraded_ended",
  degraded_started: "monitor_event_degraded_started",
  down: "monitor_event_down",
  recovered: "monitor_event_recovered",
};

export function NotificationsSection({
  channels,
  draft,
  footer,
  onChannel,
  onEvent,
  onField,
  onFlag,
}: {
  readonly channels: readonly ChannelChoice[];
  readonly draft: MonitorDraft;
  /** The form's save; this is its last section. */
  readonly footer: ReactNode;
  readonly onChannel: (id: string, on: boolean) => void;
  readonly onEvent: (kind: MonitorEventKind, on: boolean) => void;
  readonly onField: FieldChange;
  readonly onFlag: FlagChange;
}): ReactNode {
  const { t } = useMessages();
  return (
    <Section
      footer={footer}
      slot="notifications"
      title={t("monitor_section_notifications")}
    >
      <FieldGroup className="gap-3">
        <FieldLabel>{t("monitor_section_channels")}</FieldLabel>
        <FieldDescription>{t("monitor_channels_hint")}</FieldDescription>
        {channels.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              {t("monitor_channels_empty")}
            </span>
            <Link
              className={buttonVariants({ size: "sm", variant: "outline" })}
              to="/admin/channels/new"
            >
              {t("channel_add")}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-slot="monitor-channels">
            {channels.map((channel) => (
              <ChannelChoiceRow
                channel={channel}
                checked={draft.channels.includes(channel.id)}
                key={channel.id}
                onChannel={onChannel}
              />
            ))}
          </div>
        )}
      </FieldGroup>
      <EventChoices draft={draft} onEvent={onEvent} />
      <ReminderChoice draft={draft} onField={onField} onFlag={onFlag} />
    </Section>
  );
}

/** The five events as switches; the degraded pair is hidden for a heartbeat monitor, which is never degraded, and certificate expiring shows only once the form reads a certificate. */
function EventChoices({
  draft,
  onEvent,
}: {
  readonly draft: MonitorDraft;
  readonly onEvent: (kind: MonitorEventKind, on: boolean) => void;
}): ReactNode {
  const { locale, t } = useMessages();
  const withCertificate =
    draft.type === "http" && draft.tlsExpiry && isHttps(draft.url);
  const shown = monitorEventKinds.filter((kind) => {
    if (kind === "certificate_expiring") {
      return withCertificate;
    }
    if (kind === "degraded_started" || kind === "degraded_ended") {
      return draft.type !== "heartbeat";
    }
    return true;
  });
  // The threshold as the form stands, saved or not: without one the pair cannot happen (shared/domain/events.ts).
  const withThreshold = draft.degradedMs.trim() !== "";
  const days = Number(normalizeDigits(draft.tlsExpiryDays).trim());
  const certificateHint =
    Number.isInteger(days) && days > 0
      ? t("monitor_event_certificate_hint", {
          days: formatUnit(locale, days, "day", "long"),
        })
      : undefined;
  return (
    <FieldGroup className="gap-3" data-slot="monitor-events">
      <FieldLabel>{t("monitor_field_events")}</FieldLabel>
      {shown.map((kind) => {
        const degraded =
          kind === "degraded_started" || kind === "degraded_ended";
        const disabled = degraded && !withThreshold;
        let hint: string | undefined;
        if (disabled) {
          hint = t("monitor_event_degraded_hint");
        } else if (kind === "certificate_expiring") {
          hint = certificateHint;
        }
        return (
          <EventSwitch
            // An event that cannot happen shows off; the stored choice is kept for when it can.
            checked={draft.events.includes(kind) && !disabled}
            disabled={disabled}
            hint={hint}
            key={kind}
            kind={kind}
            label={t(eventLabels[kind])}
            onEvent={onEvent}
          />
        );
      })}
    </FieldGroup>
  );
}

function EventSwitch({
  checked,
  disabled,
  hint,
  kind,
  label,
  onEvent,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly hint: string | undefined;
  readonly kind: MonitorEventKind;
  readonly label: string;
  readonly onEvent: (kind: MonitorEventKind, on: boolean) => void;
}): ReactNode {
  const change = useCallback(
    (on: boolean) => onEvent(kind, on),
    [kind, onEvent]
  );
  const id = `event-${kind}`;
  return (
    <Field orientation="horizontal">
      <Switch
        checked={checked}
        data-event={kind}
        disabled={disabled}
        id={id}
        onCheckedChange={change}
      />
      <div className={cn("flex flex-col gap-0.5", disabled && "opacity-50")}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      </div>
    </Field>
  );
}

/** The reminder while down: a switch, and its interval once on. It repeats the down notification, so it waits for the down event. */
function ReminderChoice({
  draft,
  onField,
  onFlag,
}: {
  readonly draft: MonitorDraft;
  readonly onField: FieldChange;
  readonly onFlag: FlagChange;
}): ReactNode {
  const { locale, t } = useMessages();
  const withDown = draft.events.includes("down");
  // A stored interval the list does not offer stays offered, so an edit never changes it silently.
  const choices = reminderChoicesMs.includes(draft.reminderMs)
    ? reminderChoicesMs
    : [...reminderChoicesMs, draft.reminderMs].sort((a, b) => a - b);
  return (
    <FieldGroup className="gap-3">
      <FlagField
        checked={draft.reminder && withDown}
        disabled={!withDown}
        hint={t(
          withDown
            ? "monitor_field_reminder_hint"
            : "monitor_reminder_needs_down"
        )}
        label={t("monitor_field_reminder")}
        name="reminder"
        onFlag={onFlag}
        slot="monitor-reminder"
      />
      {draft.reminder && withDown ? (
        <Field className="max-w-xs">
          <FieldLabel htmlFor="reminderMs">
            {t("monitor_field_reminder_every")}
          </FieldLabel>
          <NativeSelect
            className="w-full"
            id="reminderMs"
            name="reminderMs"
            onChange={onField}
            value={String(draft.reminderMs)}
          >
            {choices.map((ms) => (
              <NativeSelectOption key={ms} value={String(ms)}>
                {intervalLabel(locale, ms)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
    </FieldGroup>
  );
}

function ChannelChoiceRow({
  channel,
  checked,
  onChannel,
}: {
  readonly channel: ChannelChoice;
  readonly checked: boolean;
  readonly onChannel: (id: string, on: boolean) => void;
}): ReactNode {
  const { t } = useMessages();
  const change = useCallback(
    (on: boolean) => onChannel(channel.id, on),
    [channel.id, onChannel]
  );
  const id = `channel-${channel.id}`;
  return (
    <Field orientation="horizontal">
      <Checkbox
        checked={checked}
        data-channel={channel.id}
        id={id}
        onCheckedChange={change}
      />
      <FieldLabel className="flex items-center gap-2" htmlFor={id}>
        <bdi>{channel.name}</bdi>
        <Badge variant="outline">
          {t(channelDeclarations[channel.type].label)}
        </Badge>
      </FieldLabel>
    </Field>
  );
}
