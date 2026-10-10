/**
 * A notification as text in the channel language: one short
 * sentence, then label-value lines, one machine token per line, so no token
 * sits mid-sentence and no isolate character is needed. Times are the
 * screen form in the install time zone and calendar with the zone label. The admin links
 * come apart, with the words that open each, so a channel that can link
 * shows the words and a plain-text one writes a label-value line.
 * Email and the chat channels use it.
 */

import { loadCatalog } from "@/server/settings/language.ts";
import {
  formatDateTimeWithZone,
  formatDuration,
  formatUnit,
} from "@/shared/i18n/format.ts";
import { createMessages, type MessageId } from "@/shared/i18n/messages.ts";
import type { NotificationLink } from "@/shared/schemas/channel.ts";
import { reasonMessageId } from "@/shared/schemas/reason.ts";
import type { ChannelPayload } from "./channel.ts";

/** A URL the text opens: the words a channel that can link shows for it, and the label-value line plain text writes. */
export interface TextLink extends NotificationLink {
  readonly line: string;
}

export interface NotificationText {
  /** The label-value lines after the sentence. */
  readonly lines: readonly string[];
  /** After the lines: the monitor's page, then the open-incident link. */
  readonly links: readonly TextLink[];
  readonly sentence: string;
  /** A subject line, for the channels that have one. */
  readonly subject: string;
}

type Kind = Exclude<ChannelPayload["notification"]["type"], "channel.test">;

const wording: Readonly<
  Record<Kind, { readonly sentence: MessageId; readonly subject: MessageId }>
> = {
  "monitor.certificate_expiring": {
    sentence: "channel_text_certificate_expiring",
    subject: "channel_subject_certificate_expiring",
  },
  "monitor.degraded_ended": {
    sentence: "channel_text_degraded_ended",
    subject: "channel_subject_degraded_ended",
  },
  "monitor.degraded_started": {
    sentence: "channel_text_degraded_started",
    subject: "channel_subject_degraded_started",
  },
  "monitor.down": {
    sentence: "channel_text_down",
    subject: "channel_subject_down",
  },
  "monitor.recovered": {
    sentence: "channel_text_recovered",
    subject: "channel_subject_recovered",
  },
  "monitor.reminder": {
    sentence: "channel_text_reminder",
    subject: "channel_subject_reminder",
  },
};

/** The text of one notification in the payload's language. */
export async function notificationText(
  payload: ChannelPayload
): Promise<NotificationText> {
  const { locale, notification, time } = payload;
  const messages = createMessages(locale, await loadCatalog(locale));
  const line = (label: MessageId, value: string) =>
    messages._(label, { value });
  const when = (iso: string) =>
    formatDateTimeWithZone(locale, Date.parse(iso), time);
  if (notification.type === "channel.test") {
    return {
      lines: [
        line("channel_line_channel", notification.data.channel.name),
        line("channel_line_time", when(notification.timestamp)),
      ],
      links: [],
      sentence: messages._("channel_text_test"),
      subject: messages._("channel_subject_test"),
    };
  }
  const { monitor } = notification.data;
  const lines = [line("channel_line_monitor", monitor.name)];
  if (monitor.target !== null) {
    lines.push(line("channel_line_target", monitor.target));
  }
  if ("reason" in notification.data) {
    lines.push(
      line(
        "channel_line_reason",
        messages._(reasonMessageId(notification.data.reason))
      )
    );
  }
  if ("downForMs" in notification.data) {
    lines.push(
      line(
        "channel_line_down_for",
        formatDuration(locale, notification.data.downForMs)
      )
    );
  }
  if ("downtimeMs" in notification.data) {
    lines.push(
      line(
        "channel_line_downtime",
        formatDuration(locale, notification.data.downtimeMs)
      )
    );
  }
  if ("certificate" in notification.data) {
    const { daysLeft, notAfter } = notification.data.certificate;
    const left = Date.parse(notAfter) - Date.parse(notification.timestamp);
    // Under a day the hours say more than "0 days"; an expired certificate has no time left to give.
    if (daysLeft >= 1) {
      lines.push(
        line("channel_line_time_left", formatUnit(locale, daysLeft, "day"))
      );
    } else if (left > 0) {
      lines.push(line("channel_line_time_left", formatDuration(locale, left)));
    }
    lines.push(line("channel_line_expires_at", when(notAfter)));
  }
  lines.push(line("channel_line_time", when(notification.timestamp)));
  const links: TextLink[] = [];
  const link = (label: MessageId, words: MessageId, url: string) =>
    links.push({ line: line(label, url), url, words: messages._(words) });
  if (monitor.adminUrl !== undefined) {
    link("channel_line_link", "channel_link_monitor", monitor.adminUrl);
  }
  if ("incidentUrl" in notification.data && notification.data.incidentUrl) {
    link(
      "channel_line_open_incident",
      "channel_link_open_incident",
      notification.data.incidentUrl
    );
  }
  const { sentence, subject } = wording[notification.type];
  return {
    lines,
    links,
    sentence: messages._(sentence),
    subject: messages._(subject, { monitor: monitor.name }),
  };
}

/** The text as one plain-text body: the sentence, a blank line, the lines, then a label-value line for each link. */
export function plainText(text: NotificationText): string {
  const lines = [...text.lines, ...text.links.map((each) => each.line)];
  return `${text.sentence}\n\n${lines.join("\n")}\n`;
}

/** The chat form of a notification without its links, which each chat channel writes after it in its own markup: the subject as its first line, a blank line, then the plain-text body. */
export function chatText(text: NotificationText): string {
  return `${text.subject}\n\n${plainText({ ...text, links: [] }).trimEnd()}`;
}

const ellipsis = "…";

/** The text cut to at most `max` units as `measure` counts them (UTF-16 code units by default), ending in an ellipsis when cut. A cut falls between graphemes, so a letter keeps its marks and a flag stays whole. */
export function clip(
  text: string,
  max: number,
  measure: (text: string) => number = (each) => each.length
): string {
  if (measure(text) <= max) {
    return text;
  }
  const characters = Array.from(
    new Intl.Segmenter().segment(text),
    ({ segment }) => segment
  );
  const fits = (count: number) =>
    measure(characters.slice(0, count).join("") + ellipsis) <= max;
  // The most characters that fit with the ellipsis, by halving.
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("") + ellipsis;
}
