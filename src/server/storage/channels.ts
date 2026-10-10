/**
 * The channels repository (CONTEXT.md "Notification channel"): one row per channel. The values of the fields that are not secret
 * are JSON text; the secret ones arrive already sealed with the install key
 * by the notify module and are stored as they came, like a monitor's
 * credentials. Deleting a channel drops its selection
 * by every monitor and its notifications. Rows never leave this file: every
 * answer is a `Channel` of shared/schemas.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { localeSchema } from "@/shared/i18n/locale.ts";
import {
  type Channel,
  type ChannelFields,
  channelTypeSchema,
} from "@/shared/schemas/channel.ts";
import type { Executor } from "./connection.ts";

export interface ChannelsRepository {
  /** Stores a new channel with its sealed secrets; answers it with its id. */
  create: (fields: ChannelFields, credentials?: string) => Promise<Channel>;
  /** The channel's sealed secrets, or nothing when it has none or does not exist. */
  credentialsOf: (id: string) => Promise<string | undefined>;
  /** The channel with that id, or nothing. */
  find: (id: string) => Promise<Channel | undefined>;
  /** Every channel, in creation order. */
  list: () => Promise<Channel[]>;
  /** Deletes the channel; answers whether it existed. */
  remove: (id: string) => Promise<boolean>;
  /** Replaces the name, the config, the language, the flag and the sealed secrets (none clears them); the id and the type stay as created. Nothing when the id is unknown. */
  update: (
    id: string,
    fields: ChannelFields,
    credentials?: string
  ) => Promise<Channel | undefined>;
}

/** Thrown by a read when a stored channel no longer fits its schema (an unknown type or config text that is not a record of strings); the message names the channel, never the text. */
export class ChannelShapeError extends Error {
  readonly channelId: string;
  constructor(id: string) {
    super(`the stored channel ${id} does not fit its schema`);
    this.name = "ChannelShapeError";
    this.channelId = id;
  }
}

/** A channel row as the driver answers it. */
interface ChannelRow {
  applies_to_new: number;
  config: string;
  created_at: number;
  id: string;
  locale: string | null;
  name: string;
  type: string;
  updated_at: number;
}

const configSchema = z.record(z.string(), z.string());

/** Ids are UUIDv7 text generated here; `newId` is a parameter so a test can fix them. */
export function channelsRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): ChannelsRepository {
  const { channels } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  const select = (where: ReturnType<typeof sql>) =>
    executor.rows<ChannelRow>(
      sql`SELECT ${channels.id} AS id, ${channels.name} AS name, ${channels.type} AS type, ${channels.config} AS config, ${channels.locale} AS locale, ${channels.appliesToNew} AS applies_to_new, ${channels.createdAt} AS created_at, ${channels.updatedAt} AS updated_at FROM ${channels} ${where} ORDER BY ${channels.createdAt}, ${channels.id}`
    );
  const findOne = async (id: string) => {
    const [row] = await select(sql`WHERE ${channels.id} = ${id}`);
    return row && channelOf(row);
  };

  return {
    create: async (fields, credentials) => {
      const id = newId();
      const time = now();
      await executor.run(
        sql`INSERT INTO ${channels} (${column("id")}, ${column("name")}, ${column("type")}, ${column("config")}, ${column("credentials")}, ${column("locale")}, ${column("applies_to_new")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${fields.name}, ${fields.type}, ${JSON.stringify(fields.config)}, ${credentials ?? null}, ${fields.locale ?? null}, ${fields.appliesToNew ? 1 : 0}, ${time}, ${time})`
      );
      const created = await findOne(id);
      if (!created) {
        throw new Error(`the channel ${id} was not stored`);
      }
      return created;
    },
    credentialsOf: async (id) => {
      const [row] = await executor.rows<{ credentials: string | null }>(
        sql`SELECT ${channels.credentials} AS credentials FROM ${channels} WHERE ${channels.id} = ${id}`
      );
      return row?.credentials ?? undefined;
    },
    find: findOne,
    list: async () => (await select(sql``)).map(channelOf),
    remove: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${channels} WHERE ${channels.id} = ${id}`
      )) > 0,
    update: async (id, fields, credentials) => {
      const changed = await executor.run(
        sql`UPDATE ${channels} SET ${column("name")} = ${fields.name}, ${column("config")} = ${JSON.stringify(fields.config)}, ${column("credentials")} = ${credentials ?? null}, ${column("locale")} = ${fields.locale ?? null}, ${column("applies_to_new")} = ${fields.appliesToNew ? 1 : 0}, ${column("updated_at")} = ${now()} WHERE ${channels.id} = ${id}`
      );
      return changed > 0 ? findOne(id) : undefined;
    },
  };
}

function channelOf(row: ChannelRow): Channel {
  const type = channelTypeSchema.safeParse(row.type);
  const config = configSchema.safeParse(parseJson(row.config));
  const locale =
    row.locale === null ? undefined : localeSchema.safeParse(row.locale);
  if (!(type.success && config.success) || locale?.success === false) {
    throw new ChannelShapeError(row.id);
  }
  return {
    appliesToNew: row.applies_to_new !== 0,
    config: config.data,
    createdAt: row.created_at,
    id: row.id,
    locale: locale?.data,
    name: row.name,
    type: type.data,
    updatedAt: row.updated_at,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
