/**
 * The channels module (CONTEXT.md "Notification channel"): what
 * the admin's server functions call to list, read, create, edit and delete
 * channels and to "send test". Every function answers a result and never
 * throws. Secrets are sealed here with the install key before
 * they reach the repository, as the monitors module does for a monitor's
 * credentials. A channel is not public content, so no
 * write here moves the change counter. "Send test" is one attempt through
 * the channel's own delivery path, not queued, recorded in its recent sends.
 * The page's read carries the notification preview (preview.ts), which
 * sends and writes nothing.
 */

import type { InstallKey } from "@/server/boot/installkey.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import { readClock } from "@/server/settings/clock.ts";
import { readInstallLanguage } from "@/server/settings/language.ts";
import { ChannelShapeError } from "@/server/storage/channels.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type Channel,
  type ChannelDeleteResult,
  type ChannelFields,
  type ChannelFormResult,
  type ChannelInput,
  type ChannelListResult,
  type ChannelSaveResult,
  type ChannelTestResult,
  type ChannelType,
  channelDeclarations,
} from "@/shared/schemas/channel.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import { type DeliverIo, deliver } from "./channel.ts";
import { previewNotifications } from "./preview.ts";
import { sendsKept } from "./queue.ts";
import { notificationChannels } from "./registry.ts";
import {
  channelValues,
  mergeValues,
  sealSecrets,
  splitValues,
  unreadableSecrets,
} from "./secrets.ts";

export type ChannelStorage = Pick<
  Storage,
  "bump" | "channels" | "notifications" | "settings"
>;

/** The channel page shows this many recent sends. */
export const recentShown = 20;

const unavailable = { ok: false, reason: "unavailable" } as const;
const invalid = { ok: false, reason: "invalid" } as const;
const notFound = { ok: false, reason: "not_found" } as const;

export async function listChannels(
  storage: ChannelStorage,
  key: InstallKey
): Promise<ChannelListResult> {
  try {
    const [channels, latest] = await Promise.all([
      storage.channels.list(),
      storage.notifications.latest(),
    ]);
    const items = await Promise.all(
      channels.map(async (channel) => ({
        channel,
        last: latest.get(channel.id),
        summary: await summaryOf(storage, key, channel),
      }))
    );
    return { channels: items, ok: true };
  } catch (error) {
    if (error instanceof ChannelShapeError) {
      return { id: error.channelId, ok: false, reason: "corrupt" };
    }
    return unavailable;
  }
}

/** The channel page's read: the channel, its generated values, the names of its kept secrets, its notification preview at `now` and its recent sends. */
export async function readChannelForm(
  storage: ChannelStorage,
  key: InstallKey,
  id: string,
  now: number
): Promise<ChannelFormResult> {
  try {
    const channel = await storage.channels.find(id);
    if (!channel) {
      return notFound;
    }
    const { fields } = channelDeclarations[channel.type];
    const [values, recent, locale, time, publicAddress] = await Promise.all([
      storedValues(storage, key, channel),
      storage.notifications.recent(id, recentShown),
      readInstallLanguage(storage),
      readClock(storage),
      readPublicAddress(storage),
    ]);
    const preview = await previewNotifications(
      channel.type,
      { locale: channel.locale ?? locale, publicAddress, time },
      now
    );
    const generated: Record<string, string> = {};
    const kept: string[] = [];
    for (const field of fields) {
      const value = values?.[field.name];
      if (value === undefined) {
        continue;
      }
      if (field.kind === "generated") {
        generated[field.name] = value;
      } else if (field.secret) {
        kept.push(field.name);
      }
    }
    return {
      form: {
        channel,
        generated,
        kept,
        preview,
        recent,
        summary: values
          ? channelDeclarations[channel.type].summary(values)
          : "",
      },
      ok: true,
    };
  } catch (error) {
    if (error instanceof ChannelShapeError) {
      return { id: error.channelId, ok: false, reason: "corrupt" };
    }
    return unavailable;
  }
}

/** Stores a new channel; its generated fields get their first values. */
export async function createChannel(
  storage: ChannelStorage,
  key: InstallKey,
  input: ChannelInput
): Promise<ChannelSaveResult> {
  const declaration = channelDeclarations[input.type];
  const values = mergeValues(declaration, input.values, undefined, {
    generate: notificationChannels[input.type].generate,
    renew: false,
  });
  if (!values) {
    return invalid;
  }
  try {
    const { config, secrets } = splitValues(declaration, values);
    const channel = await storage.channels.create(
      fieldsOf(input, config),
      await sealSecrets(key, secrets)
    );
    await movedPublicPage(storage, channel.type);
    return { channel, ok: true };
  } catch {
    return unavailable;
  }
}

/** How an edit treats what the input does not carry. */
export interface ChannelEditOptions {
  /** Every generated field gets a new value. */
  readonly renewGenerated?: boolean;
}

/** Replaces the channel's fields; a secret left out keeps the stored one. The type cannot change: that is a new channel. */
export async function editChannel(
  storage: ChannelStorage,
  key: InstallKey,
  id: string,
  input: ChannelInput,
  options: ChannelEditOptions = {}
): Promise<ChannelSaveResult> {
  try {
    const existing = await storage.channels.find(id);
    if (!existing) {
      return notFound;
    }
    if (existing.type !== input.type) {
      return invalid;
    }
    const declaration = channelDeclarations[input.type];
    // Secrets this key cannot open read as none: typing them again replaces them.
    const stored = (await storedValues(storage, key, existing)) ?? {
      ...existing.config,
    };
    const values = mergeValues(declaration, input.values, stored, {
      generate: notificationChannels[input.type].generate,
      renew: options.renewGenerated ?? false,
    });
    if (!values) {
      return invalid;
    }
    const { config, secrets } = splitValues(declaration, values);
    const channel = await storage.channels.update(
      id,
      fieldsOf(input, config),
      await sealSecrets(key, secrets)
    );
    return channel ? { channel, ok: true } : notFound;
  } catch {
    return unavailable;
  }
}

/** Deletes the channel, its selection by every monitor and its notifications. */
export async function deleteChannel(
  storage: ChannelStorage,
  id: string
): Promise<ChannelDeleteResult> {
  try {
    const existing = await storage.channels.find(id);
    if (!(existing && (await storage.channels.remove(id)))) {
      return notFound;
    }
    await movedPublicPage(storage, existing.type);
    return { ok: true };
  } catch {
    return unavailable;
  }
}

/** An email channel created or deleted changes whether a status page offers email to subscribers, so it moves the change counter; no other channel reaches a public page. */
async function movedPublicPage(
  storage: ChannelStorage,
  type: ChannelType
): Promise<void> {
  if (type === "email") {
    await storage.bump();
  }
}

/** "Send test": one `channel.test` attempt through the channel's delivery path, recorded as a finished test notification. */
export async function sendTest(
  storage: ChannelStorage,
  key: InstallKey,
  io: DeliverIo,
  id: string
): Promise<ChannelTestResult> {
  try {
    const channel = await storage.channels.find(id);
    if (!channel) {
      return notFound;
    }
    const queuedAt = io.now();
    const payload: NotificationPayload = {
      data: { channel: { id: channel.id, name: channel.name } },
      timestamp: new Date(queuedAt).toISOString(),
      type: "channel.test",
    };
    const [values, locale, time] = await Promise.all([
      storedValues(storage, key, channel),
      readInstallLanguage(storage),
      readClock(storage),
    ]);
    // The recorded row's id is the one the receiver sees, so it is drawn first.
    const notificationId = Bun.randomUUIDv7();
    const outcome = values
      ? await deliver(
          notificationChannels[channel.type],
          values,
          {
            id: notificationId,
            locale: channel.locale ?? locale,
            notification: payload,
            time,
          },
          io
        )
      : { failure: unreadableSecrets, ok: false as const };
    const at = io.now();
    const send = await storage.notifications.record({
      channelId: channel.id,
      id: notificationId,
      kind: "test",
      payload,
      queuedAt,
      settlement: outcome.ok
        ? { at, attempts: 1, status: "sent" }
        : { at, attempts: 1, failure: outcome.failure, status: "failed" },
    });
    await storage.notifications.prune(channel.id, sendsKept);
    return { ok: true, send };
  } catch {
    return unavailable;
  }
}

/** Every value of a stored channel, or nothing when the install key cannot open its secrets. */
async function storedValues(
  storage: ChannelStorage,
  key: InstallKey,
  channel: Channel
): Promise<Record<string, string> | undefined> {
  return channelValues(
    key,
    channel,
    await storage.channels.credentialsOf(channel.id)
  );
}

/** What the list shows of a channel: its type's summary of its values, or nothing readable when the key cannot open them. */
async function summaryOf(
  storage: ChannelStorage,
  key: InstallKey,
  channel: Channel
): Promise<string> {
  const values = await storedValues(storage, key, channel);
  return values ? channelDeclarations[channel.type].summary(values) : "";
}

function fieldsOf(
  input: ChannelInput,
  config: Record<string, string>
): ChannelFields {
  return {
    appliesToNew: input.appliesToNew,
    config,
    locale: input.locale,
    name: input.name,
    type: input.type,
  };
}
