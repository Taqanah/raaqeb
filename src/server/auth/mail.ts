/**
 * Auth mail: the reset link, the one-time code and the test
 * message, sent at once to the operator account's address through one email
 * channel, the one chosen on the auth settings screen or else the oldest. Not an operator notification and not queued: the
 * caller must know whether the message went, and a code retried later is
 * useless. The channel's own delivery path reports the failure.
 */
import { z } from "zod";
import type { InstallKey } from "@/server/boot/installkey.ts";
import {
  attempt,
  type DeliverIo,
  type MailMessage,
  secretsOf,
} from "@/server/notify/channel.ts";
import { emailChannel, sendMail } from "@/server/notify/email.ts";
import { mailHtml } from "@/server/notify/html.ts";
import { channelValues, unreadableSecrets } from "@/server/notify/secrets.ts";
import { plainText } from "@/server/notify/text.ts";
import { readSetting } from "@/server/settings/clock.ts";
import { loadCatalog } from "@/server/settings/language.ts";
import { readOperatorLanguage } from "@/server/settings/operator.ts";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { createMessages, type MessageId } from "@/shared/i18n/messages.ts";
import {
  type Channel,
  type ChannelValues,
  recipientsOf,
  senderOf,
} from "@/shared/schemas/channel.ts";
import type { SendFailure } from "@/shared/schemas/notification.ts";
import type { AuthMail } from "./auth.ts";

/** The id of the email channel that sends auth mail; unset means the oldest email channel. */
export const authEmailChannel: Setting<string> = defineSetting(
  "auth_email_channel",
  z.string()
);

/** The email channel the last test message went through, as it was then, and the address it went to: an edit of either asks for a new test before the second step's switch opens. */
export const authEmailTested: Setting<{
  readonly channelId: string;
  /** The operator account's address the message went to; the codes go to the address in force. */
  readonly email: string;
  readonly updatedAt: number;
}> = defineSetting(
  "auth_email_tested",
  z.object({ channelId: z.string(), email: z.string(), updatedAt: z.number() })
);

export type AuthMailStorage = Pick<Storage, "channels" | "settings">;

export type AuthMailKind = "reset_link" | "code" | "test" | "email_changed";

export interface AuthMailMessage {
  readonly kind: AuthMailKind;
  readonly to: string;
  /** The link, the code or the new address; a test carries none. */
  readonly value?: string;
}

export type AuthMailResult =
  | { readonly ok: true }
  /** No email channel exists. */
  | { readonly ok: false; readonly reason: "no_channel" }
  /** The channel's send failed, with what it saw. */
  | {
      readonly ok: false;
      readonly reason: "failed";
      readonly failure: SendFailure;
    };

/** The email channel auth mail goes through: the chosen one while it exists and is an email channel, otherwise the oldest email channel, or nothing. */
export async function authEmailChannelOf(
  storage: AuthMailStorage
): Promise<Channel | undefined> {
  const [channels, chosen] = await Promise.all([
    storage.channels.list(),
    readSetting(storage, authEmailChannel, undefined),
  ]);
  const email = channels.filter((channel) => channel.type === "email");
  return email.find((channel) => channel.id === chosen) ?? email[0];
}

/** What a send records when the database did not answer while the channel was read. */
const databaseSilent: SendFailure = {
  error: "the database did not answer",
  params: { reason: "unknown" },
  reason: "unknown",
};

/** Each message's subject and sentence; the link or the code follows on a line of its own (no token mid-sentence). */
const wording: Readonly<
  Record<
    AuthMailKind,
    { readonly subject: MessageId; readonly sentence: MessageId }
  >
> = {
  code: {
    sentence: "auth_mail_code_sentence",
    subject: "auth_mail_code_subject",
  },
  reset_link: {
    sentence: "auth_mail_reset_sentence",
    subject: "auth_mail_reset_subject",
  },
  test: {
    sentence: "auth_mail_test_sentence",
    subject: "auth_mail_test_subject",
  },
  email_changed: {
    sentence: "auth_mail_email_changed_sentence",
    subject: "auth_mail_email_changed_subject",
  },
};

/** Sends one message in the operator language through the auth email channel. Never throws. */
export async function sendAuthMail(
  storage: AuthMailStorage,
  key: InstallKey,
  io: DeliverIo,
  message: AuthMailMessage,
  /** Another email channel to send through; the test of one picked and not yet saved. */
  through?: Channel
): Promise<AuthMailResult> {
  try {
    const channel = through ?? (await authEmailChannelOf(storage));
    if (!channel) {
      return { ok: false, reason: "no_channel" };
    }
    const values: ChannelValues | undefined = await channelValues(
      key,
      channel,
      await storage.channels.credentialsOf(channel.id)
    );
    if (!values) {
      return { failure: unreadableSecrets, ok: false, reason: "failed" };
    }
    const locale = await readOperatorLanguage(storage);
    const messages = createMessages(locale, await loadCatalog(locale));
    const words = wording[message.kind];
    const text = plainText({
      lines: message.value === undefined ? [] : [message.value],
      links: [],
      sentence: messages._(words.sentence),
      subject: messages._(words.subject),
    });
    // The reset link is a button with the reset page's own title; a code or a new address stays a line of its own, left to right.
    const html = mailHtml({
      buttons:
        message.kind === "reset_link" && message.value !== undefined
          ? [{ url: message.value, words: messages._("auth_reset_title") }]
          : [],
      lines:
        message.kind !== "reset_link" && message.value !== undefined
          ? [{ text: message.value, token: message.value }]
          : [],
      locale,
      sentence: messages._(words.sentence),
      subject: messages._(words.subject),
    });
    const outcome = await attempt(
      io,
      secretsOf(emailChannel, values),
      (transport) => {
        const from = senderOf(values.from ?? "");
        if (!from) {
          throw new Error("the channel's sender is not an address");
        }
        const mail: MailMessage = {
          from,
          html,
          id: Bun.randomUUIDv7(),
          subject: messages._(words.subject),
          text,
          to: recipientsOf(message.to),
        };
        return sendMail(values, mail, transport);
      }
    );
    return outcome.ok
      ? { ok: true }
      : { failure: outcome.failure, ok: false, reason: "failed" };
  } catch {
    return { failure: databaseSilent, ok: false, reason: "failed" };
  }
}

/**
 * The mail a Better Auth instance sends, over the storage it was built on.
 * A failed send is logged, never thrown: the reset request answers every
 * address the same, and the code request answers
 * before the send ends, so the page offers a new one.
 */
export function authMailOver(
  storage: AuthMailStorage,
  key: InstallKey,
  io: DeliverIo,
  log: (line: string) => void
): AuthMail {
  const send = (message: AuthMailMessage) =>
    sendAuthMail(storage, key, io, message);
  return {
    code: async (to, code) => {
      const sent = await send({ kind: "code", to, value: code });
      if (!sent.ok) {
        log(`the one-time code was not sent: ${describe(sent)}`);
      }
    },
    resetLink: async (to, link) => {
      const sent = await send({ kind: "reset_link", to, value: link });
      if (!sent.ok) {
        log(`the reset link was not sent: ${describe(sent)}`);
      }
    },
  };
}

/** The notice an email change sends to the address the account had, naming the new one; a failed send is logged, never thrown. */
export function emailChangeNoticeOver(
  storage: AuthMailStorage,
  key: InstallKey,
  io: DeliverIo,
  log: (line: string) => void
): (previous: string, next: string) => Promise<void> {
  return async (previous, next) => {
    const sent = await sendAuthMail(storage, key, io, {
      kind: "email_changed",
      to: previous,
      value: next,
    });
    if (!sent.ok) {
      log(`the email change notice was not sent: ${describe(sent)}`);
    }
  };
}

/** A failed send in one phrase: no channel, or the reason it recorded. */
function describe(result: Extract<AuthMailResult, { ok: false }>): string {
  return result.reason === "no_channel"
    ? "no email channel"
    : result.failure.reason;
}
