/**
 * Auth mail: the reset link, the one-time code and the test
 * message, sent at once to the operator account's address through one email
 * channel, the one an owner chose on the auth settings screen. Not an operator notification and not queued: the
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
import { loadCatalog } from "@/server/settings/language.ts";
import { readOperatorLanguage } from "@/server/settings/operator.ts";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { allows, type Role } from "@/shared/domain/roles.ts";
import { createMessages, type MessageId } from "@/shared/i18n/messages.ts";
import {
  type Channel,
  type ChannelType,
  type ChannelValues,
  recipientsOf,
  senderOf,
} from "@/shared/schemas/channel.ts";
import type { SendFailure } from "@/shared/schemas/notification.ts";
import type { AuthMail } from "./auth.ts";

/** The id of the email channel that sends auth mail; never set means no choice was made yet, see `keepAuthEmailChannel`. */
export const authEmailChannel: Setting<string> = defineSetting(
  "auth_email_channel",
  z.string()
);

/** What an account's last test message proved: the channel it went through, as it was then, and the address it went to. */
export interface AuthEmailTest {
  readonly channelId: string;
  /** The account's address the message went to; the codes go to the address in force. */
  readonly email: string;
  readonly updatedAt: number;
}

const authEmailTestSchema = z.object({
  channelId: z.string(),
  email: z.string(),
  updatedAt: z.number(),
});

/** The account's last test message: an edit of the channel or of the address asks for a new test before its second step's switch opens. Removing the account removes it (`:<id>`). */
export function authEmailTestedOf(accountId: string): Setting<AuthEmailTest> {
  return defineSetting(`auth_email_tested:${accountId}`, authEmailTestSchema);
}

export type AuthMailStorage = Pick<
  Storage,
  "channels" | "operatorAccounts" | "settings"
>;

export type AuthMailKind =
  | "reset_link"
  | "code"
  | "test"
  | "email_changed"
  | "invitation";

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

/** The email channel auth mail goes through: the chosen one while it exists and is an email channel, or nothing. Never another channel: an admin may make one. Throws when the database does not answer, so a caller fails closed. */
export async function authEmailChannelOf(
  storage: Pick<Storage, "channels" | "settings">
): Promise<Channel | undefined> {
  const chosen = await storage.settings.get(authEmailChannel);
  const channel =
    chosen === undefined ? undefined : await storage.channels.find(chosen);
  return channel?.type === "email" ? channel : undefined;
}

/**
 * Records the oldest email channel as the chosen one while no choice was
 * ever stored: on an install from before the choice, or after an owner made
 * or imported the first email channel. An admin's email channel is never the
 * oldest then, since an admin may make one only while a choice is in force.
 * A choice that was stored and deleted stays, so an owner chooses again;
 * except on data from before operator accounts, which fell back to the
 * oldest channel, or to none, and had one operator to make every channel.
 */
export async function keepAuthEmailChannel(
  storage: Pick<Storage, "channels" | "settings">,
  oneOperator = false
): Promise<void> {
  const stored = await storage.settings.get(authEmailChannel);
  if (
    stored !== undefined &&
    !(oneOperator && (await authEmailChannelOf(storage)) === undefined)
  ) {
    return;
  }
  const oldest = (await storage.channels.list()).find(
    (channel) => channel.type === "email"
  );
  if (oldest) {
    await storage.settings.set(authEmailChannel, oldest.id);
  } else if (stored !== undefined) {
    // Data from before operator accounts with no email channel left: none chosen, so the owner's next one is recorded.
    await storage.settings.remove(authEmailChannel);
  }
}

/**
 * Whether the operator may make, edit or delete the channel.
 * Auth mail carries reset links, one-time codes and invitations, so whoever
 * controls the email channel it goes through could take an owner's account:
 * that channel, and every email channel while none carries auth mail,
 * are an owner's alone. Never throws: a database that cannot answer
 * allows nothing.
 */
export async function mayChangeChannel(
  storage: Pick<Storage, "channels" | "settings">,
  operator: { readonly apiKey?: unknown; readonly role: Role },
  change: { readonly id: string } | { readonly type: ChannelType }
): Promise<boolean> {
  // An owner's API key never reaches it: a key never carries the sign-in policy's permission.
  if (allows(operator, "security")) {
    return true;
  }
  try {
    const inForce = await authEmailChannelOf(storage);
    if ("id" in change) {
      // While none is in force, whichever email channel gets recorded next must be an owner's.
      return inForce === undefined
        ? (await storage.channels.find(change.id))?.type !== "email"
        : change.id !== inForce.id;
    }
    return change.type !== "email" || inForce !== undefined;
  } catch {
    return false;
  }
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
  invitation: {
    sentence: "auth_mail_invitation_sentence",
    subject: "auth_mail_invitation_subject",
  },
};

/** The links that go as a button with their page's own title; any other value stays a line of its own, left to right. */
const buttonTitles: Partial<Record<AuthMailKind, MessageId>> = {
  invitation: "team_invitation_title",
  reset_link: "auth_reset_title",
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
    // In the recipient's own language: an account's, else the install's, as for an invitation.
    const recipient = await storage.operatorAccounts.findByEmail(message.to);
    const locale = await readOperatorLanguage(storage, recipient?.preferences);
    const messages = createMessages(locale, await loadCatalog(locale));
    const words = wording[message.kind];
    const text = plainText({
      lines: message.value === undefined ? [] : [message.value],
      links: [],
      sentence: messages._(words.sentence),
      subject: messages._(words.subject),
    });
    const button = buttonTitles[message.kind];
    const html = mailHtml({
      buttons:
        button !== undefined && message.value !== undefined
          ? [{ url: message.value, words: messages._(button) }]
          : [],
      lines:
        button === undefined && message.value !== undefined
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
