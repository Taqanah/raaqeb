import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import {
  defineSetting,
  SettingShapeError,
  type SettingsRepository,
  settingsRepository,
} from "./settings.ts";

let open: { connection: Connection; cleanup: () => Promise<void> } | undefined;

async function repository(now = () => 1_700_000_000_000): Promise<{
  connection: Connection;
  settings: SettingsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection };
  await migrateDatabase(connection);
  return {
    connection,
    settings: settingsRepository(executor(connection), now),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const retentionDays = defineSetting(
  "retention_days",
  z.number().int().positive()
);
const installLanguage = defineSetting("install_language", z.enum(["ar", "en"]));
const appearance = defineSetting(
  "appearance",
  z.object({ density: z.enum(["compact", "comfortable"]), radius: z.number() })
);

describe("a setting", () => {
  test("set then read is the same value, typed by its schema", async () => {
    const { settings } = await repository();
    await settings.set(retentionDays, 90);
    await settings.set(installLanguage, "ar");
    await settings.set(appearance, { density: "compact", radius: 8 });
    expect(await settings.get(retentionDays)).toBe(90);
    expect(await settings.get(installLanguage)).toBe("ar");
    expect(await settings.get(appearance)).toEqual({
      density: "compact",
      radius: 8,
    });
  });

  test("set again replaces the earlier value", async () => {
    const { settings } = await repository();
    await settings.set(retentionDays, 90);
    await settings.set(retentionDays, 365);
    expect(await settings.get(retentionDays)).toBe(365);
  });

  test("never set answers nothing, and removed answers nothing again", async () => {
    const { settings } = await repository();
    expect(await settings.get(retentionDays)).toBe(undefined);
    await settings.set(retentionDays, 90);
    await settings.remove(retentionDays);
    expect(await settings.get(retentionDays)).toBe(undefined);
  });

  test("is stored as JSON text with the time it was written", async () => {
    const { connection, settings } = await repository(() => 1_726_400_000_000);
    await settings.set(appearance, { density: "compact", radius: 8 });
    const rows = await executor(connection).rows<{
      key: string;
      value: string;
      updated_at: number;
    }>(sql`SELECT key, value, updated_at FROM settings`);
    expect(rows).toEqual([
      {
        key: "appearance",
        updated_at: 1_726_400_000_000,
        value: '{"density":"compact","radius":8}',
      },
    ]);
  });

  test("a stored value that no longer fits its schema is refused naming the key, not the value", async () => {
    const { connection, settings } = await repository();
    await executor(connection).run(
      sql`INSERT INTO settings (key, value, updated_at) VALUES ('retention_days', '"SECRET_TEXT"', 0)`
    );
    let message = "";
    try {
      await settings.get(retentionDays);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("retention_days");
    expect(message).not.toContain("SECRET_TEXT");
  });
});

describe("a stored value that does not fit its schema", () => {
  test("throws the settings repository's own error, so a caller can tell it from a database failure", async () => {
    const { settings } = await repository();
    const loose = defineSetting<string>("shape_probe", z.string());
    await settings.set(loose, "text");
    const strict = defineSetting("shape_probe", z.number());
    await expect(settings.get(strict)).rejects.toBeInstanceOf(
      SettingShapeError
    );
  });
});
