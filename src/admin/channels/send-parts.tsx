/**
 * How a notification's outcome reads on the channel screens: its status as a badge in the status colours, and a failure as its
 * reason worded in the reader's locale with the driver's text as a token.
 */
import type { ReactNode } from "react";
import { FailureDetail } from "@/admin/monitors/check-parts.tsx";
import { eventLabels } from "@/admin/monitors/notification-section.tsx";
import {
  formatDateTimeWithZone,
  type TimeOptions,
} from "@/shared/i18n/format.ts";
import type { MessageId } from "@/shared/i18n/messages.ts";
import { useMessages } from "@/shared/i18n/react.tsx";
import type {
  Notification,
  NotificationStatus,
  NotificationType,
  SendFailure,
} from "@/shared/schemas/notification.ts";
import { reasonMessageId } from "@/shared/schemas/reason.ts";
import { Badge } from "@/shared/ui/badge.tsx";

/** A monitor event's notification by the monitor form's label for its event; a reminder by the form's reminder switch. */
const eventTypeLabels: Readonly<
  Record<Exclude<NotificationType, "channel.test">, MessageId>
> = {
  "monitor.certificate_expiring": eventLabels.certificate_expiring,
  "monitor.degraded_ended": eventLabels.degraded_ended,
  "monitor.degraded_started": eventLabels.degraded_started,
  "monitor.down": eventLabels.down,
  "monitor.recovered": eventLabels.recovered,
  "monitor.reminder": "monitor_field_reminder",
};

/** What a send shows: its stored status, except a pending one no attempt has failed yet, which is queued. */
type SendState = NotificationStatus | "queued";

const stateWords: Readonly<Record<SendState, MessageId>> = {
  failed: "channel_send_failed",
  pending: "channel_send_pending",
  queued: "channel_send_queued",
  sent: "channel_send_sent",
};

const stateVariants = {
  failed: "down",
  pending: "degraded",
  queued: "secondary",
  sent: "up",
} as const;

/** A send's status, and the failure of its last attempt: a pending one without a failure has not been tried yet. */
export function SendStatus({
  send,
  slot,
}: {
  readonly send: {
    readonly failure: SendFailure | undefined;
    readonly status: NotificationStatus;
  };
  readonly slot?: string;
}): ReactNode {
  const { t } = useMessages();
  const state: SendState =
    send.status === "pending" && send.failure === undefined
      ? "queued"
      : send.status;
  return (
    <Badge
      data-slot={slot}
      data-status={send.status}
      variant={stateVariants[state]}
    >
      {t(stateWords[state])}
    </Badge>
  );
}

/** A failed attempt: the reason in words, then what it saw and the driver's text, as the monitor screens show a failure. */
export function SendFailureText({
  failure,
}: {
  readonly failure: SendFailure;
}): ReactNode {
  const { t } = useMessages();
  return (
    <div className="flex flex-col gap-2 text-sm" data-reason={failure.reason}>
      <span>{t(reasonMessageId(failure.reason))}</span>
      <FailureDetail failure={failure} />
    </div>
  );
}

/** One row of the recent sends: what was sent, how it went and when. */
export function SendRow({
  clock,
  send,
}: {
  readonly clock: TimeOptions;
  readonly send: Notification;
}): ReactNode {
  const { locale, t } = useMessages();
  return (
    <li
      className="flex flex-col gap-2 border-border border-b py-3 last:border-b-0"
      data-send={send.id}
      data-status={send.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <SendStatus send={send} />
        {send.payload.type === "channel.test" ? (
          <Badge variant="secondary">{t("channel_send_test_kind")}</Badge>
        ) : (
          <span>{t(eventTypeLabels[send.payload.type])}</span>
        )}
        <span className="text-muted-foreground">
          {formatDateTimeWithZone(
            locale,
            send.finishedAt ?? send.queuedAt,
            clock
          )}
        </span>
        <span className="text-muted-foreground">
          {t("channel_send_attempts", { count: send.attempts })}
        </span>
      </div>
      {send.failure ? <SendFailureText failure={send.failure} /> : null}
      {send.nextAttemptAt === undefined ? null : (
        <p className="text-muted-foreground text-xs">
          {t("channel_send_next", {
            when: formatDateTimeWithZone(locale, send.nextAttemptAt, clock),
          })}
        </p>
      )}
    </li>
  );
}
