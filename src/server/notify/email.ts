/**
 * The email channel: the
 * notification's text as one message over SMTP, its plain-text part and an
 * HTML part that shows the same lines. Its own delivery path reports its own
 * failures: a refused message is a failed attempt, never a silent success.
 * Direct-to-MX is never offered.
 */
import {
  type ChannelValues,
  emailDeclaration,
  recipientsOf,
  type SmtpSecurity,
  senderOf,
  smtpSecurities,
} from "@/shared/schemas/channel.ts";
import type {
  ChannelPayload,
  MailMessage,
  NotificationChannel,
  Transport,
} from "./channel.ts";
import { mailHtml } from "./html.ts";
import { type NotificationText, notificationText, plainText } from "./text.ts";

/** Sends one message over the channel's SMTP server; auth mail (server/auth/mail.ts) sends its own text through it. */
export function sendMail(
  values: ChannelValues,
  message: MailMessage,
  transport: Transport
): Promise<void> {
  // A channel stored with a provider transport, which the email channel no longer has, has no host; nodemailer would try localhost.
  if (!values.host) {
    return Promise.reject(new Error("the channel has no SMTP server"));
  }
  const security: SmtpSecurity =
    smtpSecurities.find((each) => each === values.security) ?? "starttls";
  // AUTH never crosses a plain connection, whatever is stored.
  const username =
    security === "none" || !values.username ? undefined : values.username;
  return transport.smtp(
    {
      host: values.host,
      password: username === undefined ? undefined : values.password,
      port: Number(values.port),
      security,
      username,
    },
    message
  );
}

/** A notification's HTML part: from Raaqeb, a monitor's name as its heading in place of the line that names it, the other lines with the monitor's target left to right, and each link as a button with its words. The channel's preview shows the same. */
export function notificationHtml(
  payload: ChannelPayload,
  text: NotificationText
): string {
  const { locale, notification } = payload;
  const monitor =
    notification.type === "channel.test"
      ? undefined
      : notification.data.monitor;
  const target = monitor?.target ?? undefined;
  return mailHtml({
    buttons: text.links.map(({ url, words }) => ({ url, words })),
    heading: monitor?.name,
    // text.ts writes a monitor's line first.
    lines: (monitor ? text.lines.slice(1) : text.lines).map((line) => ({
      text: line,
      token: target !== undefined && line.includes(target) ? target : undefined,
    })),
    locale,
    sentence: text.sentence,
    subject: text.subject,
  });
}

export const emailChannel: NotificationChannel = {
  declaration: emailDeclaration,
  generate: {},
  send: async (values, payload, transport) => {
    const from = senderOf(values.from ?? "");
    if (!from) {
      throw new Error("the channel's sender is not an address");
    }
    const text = await notificationText(payload);
    const message: MailMessage = {
      from,
      html: notificationHtml(payload, text),
      id: payload.id,
      subject: text.subject,
      text: plainText(text),
      to: recipientsOf(values.to ?? ""),
    };
    return sendMail(values, message, transport);
  },
};
