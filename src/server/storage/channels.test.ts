import { afterEach, describe, expect, test } from "bun:test";
import type { ChannelFields } from "@/shared/schemas/channel.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";
import type { NotificationPayload } from "@/shared/schemas/notification.ts";
import {
  ChannelShapeError,
  type ChannelsRepository,
  channelsRepository,
} from "./channels.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import {
  type NotificationsRepository,
  notificationsRepository,
} from "./notifications.ts";
import type { DatabaseLocation } from "./storage.ts";

let open:
  | {
      connection: Connection;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

let clock = 1_700_000_000_000;

async function repositories(): Promise<{
  channels: ChannelsRepository;
  location: DatabaseLocation;
  monitors: MonitorsRepository;
  notifications: NotificationsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  const run = executor(connection);
  let nextId = 0;
  const newId = () => {
    nextId += 1;
    return `id-${String(nextId).padStart(3, "0")}`;
  };
  return {
    channels: channelsRepository(run, () => clock, newId),
    location: scratch.location,
    monitors: monitorsRepository(run, () => clock, newId),
    notifications: notificationsRepository(run, newId),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const ops: ChannelFields = {
  appliesToNew: true,
  config: {},
  locale: undefined,
  name: "فريق التشغيل",
  type: "webhook",
};

const site: MonitorInput = {
  channels: [],
  events: [...monitorEventKinds],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  intervalMs: 60_000,
  name: "الموقع",
  retries: 2,
  tags: [],
  timeoutMs: 10_000,
};

const sample: NotificationPayload = {
  data: { channel: { id: "c", name: "Ops" } },
  timestamp: "2026-09-25T10:00:00.000Z",
  type: "channel.test",
};

describe("the channels repository", () => {
  test("stores a channel and answers it by id and in the list, in creation order", async () => {
    const { channels } = await repositories();
    const first = await channels.create(ops, "1.sealed");
    clock += 1000;
    const second = await channels.create({
      ...ops,
      appliesToNew: false,
      config: { room: "ops" },
      locale: "en",
      name: "Night shift",
    });
    expect(first).toEqual({
      ...ops,
      createdAt: 1_700_000_000_000,
      id: first.id,
      updatedAt: 1_700_000_000_000,
    });
    expect(await channels.find(second.id)).toEqual(second);
    expect(second.locale).toBe("en");
    expect(second.config).toEqual({ room: "ops" });
    expect((await channels.list()).map((channel) => channel.name)).toEqual([
      "فريق التشغيل",
      "Night shift",
    ]);
    expect(await channels.find("nope")).toBeUndefined();
  });

  test("keeps the sealed secrets as given, apart from the channel it answers", async () => {
    const { channels, location } = await repositories();
    const created = await channels.create(ops, "1.ciphertext");
    expect(await channels.credentialsOf(created.id)).toBe("1.ciphertext");
    expect(JSON.stringify(created)).not.toContain("ciphertext");
    const rows = await runSql(
      location,
      "SELECT credentials FROM channels WHERE id = ?",
      [created.id]
    );
    expect(rows).toEqual([{ credentials: "1.ciphertext" }]);
    const plain = await channels.create({ ...ops, name: "plain" });
    expect(await channels.credentialsOf(plain.id)).toBeUndefined();
  });

  test("an edit replaces the fields and the secrets, keeps the id, the type and the creation time", async () => {
    const { channels } = await repositories();
    const created = await channels.create(ops, "1.old");
    clock += 5000;
    const updated = await channels.update(
      created.id,
      { ...ops, appliesToNew: false, locale: "ar", name: "Ops" },
      "1.new"
    );
    expect(updated).toEqual({
      ...ops,
      appliesToNew: false,
      createdAt: created.createdAt,
      id: created.id,
      locale: "ar",
      name: "Ops",
      updatedAt: clock,
    });
    expect(await channels.credentialsOf(created.id)).toBe("1.new");
    await channels.update(created.id, ops);
    expect(await channels.credentialsOf(created.id)).toBeUndefined();
    expect(await channels.update("nope", ops)).toBeUndefined();
  });

  test("deleting a channel drops it from every monitor's selection and drops its notifications", async () => {
    const { channels, monitors, notifications } = await repositories();
    const kept = await channels.create({ ...ops, name: "kept" });
    const gone = await channels.create({ ...ops, name: "gone" });
    const monitor = await monitors.create({
      ...site,
      channels: [kept.id, gone.id],
    });
    await notifications.enqueue([gone.id, kept.id], "test", sample, clock);
    expect(await channels.remove(gone.id)).toBe(true);
    expect(await channels.remove(gone.id)).toBe(false);
    expect((await monitors.find(monitor.id))?.channels).toEqual([kept.id]);
    expect(await notifications.recent(gone.id, 10)).toEqual([]);
    expect(await notifications.recent(kept.id, 10)).toHaveLength(1);
  });

  test("a stored channel this version cannot read is named, never read as another", async () => {
    const { channels, location } = await repositories();
    const created = await channels.create(ops);
    await runSql(location, "UPDATE channels SET type = ? WHERE id = ?", [
      "teams",
      created.id,
    ]);
    await expect(channels.find(created.id)).rejects.toBeInstanceOf(
      ChannelShapeError
    );
    await runSql(
      location,
      "UPDATE channels SET type = ?, config = ? WHERE id = ?",
      ["webhook", '{"room": 5}', created.id]
    );
    await expect(channels.list()).rejects.toThrow(created.id);
  });
});

describe("a monitor's channel selection", () => {
  test("a monitor stores the channels it selects and reads them back in id order", async () => {
    const { channels, monitors } = await repositories();
    const a = await channels.create({ ...ops, name: "a" });
    const b = await channels.create({ ...ops, name: "b" });
    const monitor = await monitors.create({ ...site, channels: [b.id, a.id] });
    expect(monitor.channels).toEqual([a.id, b.id]);
    expect((await monitors.list())[0]?.channels).toEqual([a.id, b.id]);
  });

  test("an edit replaces the selection, and a channel that no longer exists is skipped", async () => {
    const { channels, monitors } = await repositories();
    const a = await channels.create({ ...ops, name: "a" });
    const monitor = await monitors.create({ ...site, channels: [a.id] });
    const b = await channels.create({ ...ops, name: "b" });
    const updated = await monitors.update(monitor.id, {
      ...site,
      channels: [b.id, "deleted-meanwhile"],
    });
    expect(updated?.channels).toEqual([b.id]);
    const created = await monitors.create({
      ...site,
      channels: ["deleted-meanwhile"],
      name: "other",
    });
    expect(created.channels).toEqual([]);
  });

  test("deleting a monitor drops its selection and leaves the channel", async () => {
    const { channels, location, monitors } = await repositories();
    const a = await channels.create(ops);
    const monitor = await monitors.create({ ...site, channels: [a.id] });
    await monitors.remove([monitor.id]);
    expect(await runSql(location, "SELECT * FROM monitor_channels")).toEqual(
      []
    );
    expect(await channels.find(a.id)).toBeDefined();
  });
});
