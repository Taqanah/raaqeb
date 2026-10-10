/**
 * A channel's values at rest: the
 * fields its type declares secret are sealed with the install key into one
 * column, the rest are stored as they are. A typed secret the form leaves
 * out keeps the stored one; a generated one is made on create and again
 * when the operator asks for a new one.
 */
import { z } from "zod";
import { decrypt, encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import {
  type Channel,
  type ChannelDeclaration,
  type ChannelField,
  fieldsFor,
} from "@/shared/schemas/channel.ts";
import type { SendFailure } from "@/shared/schemas/notification.ts";

/** What an edit does beside the typed values. */
export interface MergeOptions {
  /** Makes a generated field's value, by field name. */
  readonly generate: Readonly<Record<string, () => string>>;
  /** Every generated field gets a new value. */
  readonly renew: boolean;
}

/** Every value to store of the fields that apply to what was typed: typed ones as posted, a secret left out taken from the stored ones, a generated one kept or made, an optional one left out dropped; nothing when a required value is missing or a value does not fit its field. Names the type does not declare, and fields that do not apply, are dropped. */
export function mergeValues(
  declaration: ChannelDeclaration,
  typed: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, string>> | undefined,
  options: MergeOptions
): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const field of fieldsFor(declaration, typed)) {
    const value = fieldValue(field, typed, stored, options);
    if (value === undefined && field.optional) {
      continue;
    }
    if (value === undefined || !field.value.safeParse(value).success) {
      return;
    }
    values[field.name] = value;
  }
  return values;
}

/** One field's value to store, or nothing when it has none. */
function fieldValue(
  field: ChannelField,
  typed: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, string>> | undefined,
  options: MergeOptions
): string | undefined {
  if (field.kind === "generated") {
    const kept = options.renew ? undefined : stored?.[field.name];
    return kept ?? options.generate[field.name]?.();
  }
  const posted = typed[field.name]?.trim();
  if (posted !== undefined && posted !== "") {
    return posted;
  }
  // Only a secret keeps its stored value; a field in clear is shown in the form, so an empty one means empty.
  return field.secret ? stored?.[field.name] : undefined;
}

/** The values split into what is stored in clear and what is sealed. */
export function splitValues(
  declaration: ChannelDeclaration,
  values: Readonly<Record<string, string>>
): {
  readonly config: Record<string, string>;
  readonly secrets: Record<string, string>;
} {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of declaration.fields) {
    const value = values[field.name];
    if (value !== undefined) {
      (field.secret ? secrets : config)[field.name] = value;
    }
  }
  return { config, secrets };
}

/** The ciphertext of the secrets, or nothing when there are none. */
export function sealSecrets(
  key: InstallKey,
  secrets: Readonly<Record<string, string>>
): Promise<string | undefined> {
  if (Object.keys(secrets).length === 0) {
    return Promise.resolve(undefined);
  }
  return encrypt(key, JSON.stringify(secrets));
}

/** A record of strings, which is what a channel's secrets and config are. */
export const valuesSchema = z.record(z.string(), z.string());

/** The secrets behind a ciphertext, or nothing when the key cannot open it or it holds something else than a record of strings. */
export async function openSecrets(
  key: InstallKey,
  sealed: string
): Promise<Record<string, string> | undefined> {
  const text = await decrypt(key, sealed);
  if (text === undefined) {
    return;
  }
  const parsed = valuesSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller reads it as no secrets.
  }
}

/** What an attempt records when the install key cannot open the channel's secrets; typing them again repairs the channel. */
export const unreadableSecrets: SendFailure = {
  error: "the install key cannot open this channel's secrets",
  params: { reason: "unknown" },
  reason: "unknown",
};

/** Every value of a stored channel, its secrets opened; nothing when the key cannot open them. */
export async function channelValues(
  key: InstallKey,
  channel: Pick<Channel, "config">,
  sealed: string | undefined
): Promise<Record<string, string> | undefined> {
  if (sealed === undefined) {
    return { ...channel.config };
  }
  const secrets = await openSecrets(key, sealed);
  return secrets && { ...channel.config, ...secrets };
}
