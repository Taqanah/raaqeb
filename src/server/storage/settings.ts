/**
 * The settings repository (CONTEXT.md "Setting"): every value the
 * operator edits in the admin area, one row per setting, the value as JSON
 * text parsed with Zod when read. Each setting is declared once with its key
 * and schema, so a call site cannot read one as the wrong type.
 */
import { sql } from "drizzle-orm";
import type { ZodType } from "zod";
import type { Executor } from "./connection.ts";

/** A setting's declaration: its row key and the schema of its value. */
export interface Setting<T> {
  readonly key: string;
  readonly schema: ZodType<T>;
}

/** Thrown by `get` when the stored JSON no longer fits the setting's schema; a database failure is any other error. */
export class SettingShapeError extends Error {
  constructor(key: string) {
    // The stored text could be a credential; the message carries the key only.
    super(`the stored value of the setting ${key} does not fit its schema`);
    this.name = "SettingShapeError";
  }
}

export function defineSetting<T>(key: string, schema: ZodType<T>): Setting<T> {
  return { key, schema };
}

export interface SettingsRepository {
  /** The stored value, or nothing when the setting was never set. Throws naming the key when the stored JSON no longer fits the schema. */
  get: <T>(setting: Setting<T>) => Promise<T | undefined>;
  /** Forgets the setting, so `get` answers nothing again. */
  remove: (setting: Setting<unknown>) => Promise<void>;
  /** Stores the value, replacing any earlier one. */
  set: <T>(setting: Setting<T>, value: T) => Promise<void>;
}

export function settingsRepository(
  executor: Executor,
  now: () => number
): SettingsRepository {
  const { settings } = executor.tables;
  return {
    get: async (setting) => {
      const rows = await executor.rows<{ value: string }>(
        sql`SELECT ${settings.value} AS value FROM ${settings} WHERE ${settings.key} = ${setting.key}`
      );
      const [stored] = rows;
      if (!stored) {
        return;
      }
      const parsed = setting.schema.safeParse(parseJson(stored.value));
      if (!parsed.success) {
        throw new SettingShapeError(setting.key);
      }
      return parsed.data;
    },
    remove: async (setting) => {
      await executor.run(
        sql`DELETE FROM ${settings} WHERE ${settings.key} = ${setting.key}`
      );
    },
    set: async (setting, value) => {
      const text = JSON.stringify(value);
      const key = sql.identifier(settings.key.name);
      const column = sql.identifier(settings.value.name);
      const updatedAt = sql.identifier(settings.updatedAt.name);
      await executor.run(
        sql`INSERT INTO ${settings} (${key}, ${column}, ${updatedAt}) VALUES (${setting.key}, ${text}, ${now()}) ON CONFLICT (${key}) DO UPDATE SET ${column} = excluded.${column}, ${updatedAt} = excluded.${updatedAt}`
      );
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
