import { afterEach, describe, expect, test } from "bun:test";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds, tagsMax } from "@/shared/schemas/monitor.ts";
import { channelsRepository } from "./channels.ts";
import { type Connection, closeConnection, executor } from "./connection.ts";
import { connectTo, runSql, scratchDatabase } from "./fixture.ts";
import { migrateDatabase } from "./migrate.ts";
import { localMigrations, migrationsFolder } from "./migrationfiles.ts";
import {
  type MonitorsRepository,
  monitorsRepository,
  newHeartbeatToken,
} from "./monitors.ts";
import type { DatabaseLocation } from "./storage.ts";

let open:
  | {
      connection: Connection;
      cleanup: () => Promise<void>;
      location: DatabaseLocation;
    }
  | undefined;

let clock = 1_700_000_000_000;
let nextId = 0;
let nextToken = 0;

/** A fixed token in the shape of a real one, 22 characters. */
const tokenNumber = (n: number) => `token${String(n).padStart(17, "0")}`;

async function repository(): Promise<{
  location: DatabaseLocation;
  monitors: MonitorsRepository;
}> {
  const scratch = await scratchDatabase();
  const connection = await connectTo(scratch.location);
  open = { cleanup: scratch.cleanup, connection, location: scratch.location };
  await migrateDatabase(connection);
  clock = 1_700_000_000_000;
  nextId = 0;
  nextToken = 0;
  return {
    location: scratch.location,
    monitors: monitorsRepository(
      executor(connection),
      () => clock,
      () => {
        nextId += 1;
        return `id-${String(nextId).padStart(3, "0")}`;
      },
      () => {
        nextToken += 1;
        return tokenNumber(nextToken);
      }
    ),
  };
}

afterEach(async () => {
  if (open) {
    await closeConnection(open.connection);
    await open.cleanup();
    open = undefined;
  }
});

const site: MonitorInput = {
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  description: "الصفحة الرئيسية",
  group: "الإنتاج",
  intervalMs: 60_000,
  name: "الموقع",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: ["عام", "ويب"],
  timeoutMs: 10_000,
};

const mail: MonitorInput = {
  config: { host: "mail.example.test", port: 25, type: "tcp" },
  degradedMs: 500,
  intervalMs: 120_000,
  name: "البريد",
  retries: 0,
  channels: [],
  events: [...monitorEventKinds],
  tags: ["عام"],
  timeoutMs: 5000,
};

async function rowCount(
  location: DatabaseLocation,
  table: string
): Promise<number> {
  const [row] = await runSql(location, `SELECT count(*) AS n FROM ${table}`);
  return Number(row?.n);
}

describe("creating a monitor", () => {
  test("stores it active with a generated id and the time, and reads it back whole", async () => {
    const { monitors } = await repository();
    const created = await monitors.create(site);
    expect(created).toEqual({
      ...site,
      createdAt: clock,
      id: "id-001",
      paused: false,
      target: "https://example.test/",
      updatedAt: clock,
    });
    expect(await monitors.find("id-001")).toEqual(created);
    expect(await monitors.list()).toEqual([created]);
  });

  test("a heartbeat monitor has no target and a TCP one has host and port", async () => {
    const { monitors } = await repository();
    const beat = await monitors.create({
      config: {
        schedule: { everyMs: 300_000, kind: "every" },
        type: "heartbeat",
      },
      intervalMs: 60_000,
      name: "النسخ الاحتياطي",
      retries: 0,
      channels: [],
      events: [...monitorEventKinds],
      tags: [],
      timeoutMs: 10_000,
    });
    expect(beat.target).toBe(undefined);
    expect((await monitors.create(mail)).target).toBe("mail.example.test:25");
  });

  test("a new group name creates the group once and a second monitor joins it", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    await monitors.create({ ...mail, group: "الإنتاج" });
    expect(await rowCount(location, "groups")).toBe(1);
    const listed = await monitors.list();
    expect(listed.map((m) => m.group)).toEqual(["الإنتاج", "الإنتاج"]);
  });

  test("a tag is one row however many monitors carry it, and a monitor carries each tag once", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    const second = await monitors.create({ ...mail, tags: ["عام", "عام"] });
    expect(await rowCount(location, "tags")).toBe(2);
    expect((await monitors.find(second.id))?.tags).toEqual(["عام"]);
  });

  test("a tag name is exact: a different case or spelling is another tag", async () => {
    const { location, monitors } = await repository();
    await monitors.create({ ...mail, tags: ["Public", "public"] });
    expect(await rowCount(location, "tags")).toBe(2);
  });

  test("a create that fails half way leaves nothing behind: no monitor, no group, no tag", async () => {
    const scratch = await scratchDatabase();
    const connection = await connectTo(scratch.location);
    open = { cleanup: scratch.cleanup, connection, location: scratch.location };
    await migrateDatabase(connection);
    // The third id is the tag's: the monitor and the group are already written when it throws.
    let calls = 0;
    const failing = monitorsRepository(
      executor(connection),
      () => clock,
      () => {
        calls += 1;
        if (calls === 3) {
          throw new Error("no more ids");
        }
        return `id-${calls}`;
      }
    );
    await expect(failing.create(site)).rejects.toThrow("no more ids");
    expect(await rowCount(scratch.location, "monitors")).toBe(0);
    expect(await rowCount(scratch.location, "groups")).toBe(0);
  });

  test("an unknown id is nothing", async () => {
    const { monitors } = await repository();
    expect(await monitors.find("id-999")).toBe(undefined);
  });
});

describe("editing a monitor", () => {
  test("replaces every field, keeps the id, the creation time and the paused state, and moves the update time", async () => {
    const { monitors } = await repository();
    await monitors.create(site);
    await monitors.pause(["id-001"]);
    clock += 1000;
    const edited = await monitors.update("id-001", mail);
    expect(edited).toEqual({
      ...mail,
      createdAt: 1_700_000_000_000,
      id: "id-001",
      paused: true,
      pausedAt: 1_700_000_000_000,
      target: "mail.example.test:25",
      updatedAt: clock,
    });
    expect(await monitors.find("id-001")).toEqual(edited);
  });

  test("the last monitor to leave a group or drop a tag removes it, so the filters never offer an empty one", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    await monitors.update("id-001", {
      ...site,
      group: "الاختبار",
      tags: ["ويب"],
    });
    expect(await runSql(location, "SELECT name FROM groups")).toEqual([
      { name: "الاختبار" },
    ]);
    expect(await runSql(location, "SELECT name FROM tags")).toEqual([
      { name: "ويب" },
    ]);
  });

  test("a group or a tag another monitor still carries stays", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    await monitors.create({ ...mail, group: "الإنتاج" });
    await monitors.update("id-001", { ...site, group: undefined, tags: [] });
    expect(await rowCount(location, "groups")).toBe(1);
    expect(await rowCount(location, "tags")).toBe(1);
  });

  test("an unknown id changes nothing and answers nothing", async () => {
    const { location, monitors } = await repository();
    expect(await monitors.update("id-999", site)).toBe(undefined);
    expect(await rowCount(location, "monitors")).toBe(0);
    expect(await rowCount(location, "groups")).toBe(0);
  });
});

describe("pausing and resuming", () => {
  test("pause stops the checks of the named monitors and answers how many changed state", async () => {
    const { monitors } = await repository();
    const first = await monitors.create(site);
    const second = await monitors.create(mail);
    expect(await monitors.pause([first.id, second.id, "id-999"])).toBe(2);
    expect((await monitors.list()).map((m) => m.paused)).toEqual([true, true]);
    expect(await monitors.pause([first.id])).toBe(0);
  });

  test("resume lets them run again and counts only the ones that were paused", async () => {
    const { monitors } = await repository();
    const first = await monitors.create(site);
    const second = await monitors.create(mail);
    await monitors.pause([first.id]);
    expect(await monitors.resume([first.id, second.id])).toBe(1);
    expect((await monitors.find(first.id))?.paused).toBe(false);
  });

  test("a pause records when the monitor was paused and a resume clears it, each moving the update time and touching nothing else", async () => {
    const { monitors } = await repository();
    const created = await monitors.create(site);
    clock += 5000;
    await monitors.pause([created.id]);
    expect(await monitors.find(created.id)).toEqual({
      ...created,
      paused: true,
      pausedAt: clock,
      updatedAt: clock,
    });
    clock += 5000;
    await monitors.resume([created.id]);
    expect(await monitors.find(created.id)).toEqual({
      ...created,
      updatedAt: clock,
    });
  });

  test("pausing a monitor already paused keeps the time it was first paused", async () => {
    const { monitors } = await repository();
    const created = await monitors.create(site);
    await monitors.pause([created.id]);
    const first = clock;
    clock += 60_000;
    await monitors.pause([created.id]);
    expect((await monitors.find(created.id))?.pausedAt).toBe(first);
  });

  test("an edit of a paused monitor keeps the time it was paused", async () => {
    const { monitors } = await repository();
    const created = await monitors.create(site);
    await monitors.pause([created.id]);
    const pausedAt = clock;
    clock += 60_000;
    await monitors.update(created.id, { ...site, name: "Renamed" });
    const edited = await monitors.find(created.id);
    expect(edited?.pausedAt).toBe(pausedAt);
    expect(edited?.updatedAt).toBe(clock);
  });

  test("monitors paused together share one pause time", async () => {
    const { monitors } = await repository();
    const first = await monitors.create(site);
    const second = await monitors.create(mail);
    await monitors.pause([first.id, second.id]);
    expect((await monitors.list()).map((monitor) => monitor.pausedAt)).toEqual([
      clock,
      clock,
    ]);
  });

  test("the migration gives a monitor paused before it its last change as the time it was paused", async () => {
    const { location, monitors } = await repository();
    const created = await monitors.create(site);
    await monitors.pause([created.id]);
    await monitors.create(mail);
    await runSql(
      location,
      "UPDATE monitors SET paused_at = NULL, updated_at = ? WHERE id = ?",
      [1_690_000_000_000, created.id]
    );
    const [name] = (await localMigrations(location.backend)).filter((each) =>
      each.endsWith("_status_pages")
    );
    const text = await Bun.file(
      `${migrationsFolder(location.backend)}/${name}/migration.sql`
    ).text();
    const dataStep = text.split("--> statement-breakpoint").at(-1) ?? "";
    await runSql(location, dataStep);
    const [paused, running] = await monitors.list();
    expect(paused?.pausedAt).toBe(1_690_000_000_000);
    expect(running?.pausedAt).toBeUndefined();
  });
});

describe("deleting monitors", () => {
  test("removes the named monitors, their tag links and any group or tag left empty, and answers how many existed", async () => {
    const { location, monitors } = await repository();
    const first = await monitors.create(site);
    const second = await monitors.create(mail);
    expect(await monitors.remove([first.id, "id-999"])).toBe(1);
    expect((await monitors.list()).map((m) => m.id)).toEqual([second.id]);
    expect(await rowCount(location, "monitor_tags")).toBe(1);
    expect(await rowCount(location, "groups")).toBe(0);
    expect(await runSql(location, "SELECT name FROM tags")).toEqual([
      { name: "عام" },
    ]);
  });

  test("deleting nothing that exists answers zero", async () => {
    const { monitors } = await repository();
    expect(await monitors.remove(["id-999"])).toBe(0);
  });
});

describe("the list", () => {
  test("is in creation order, whatever was edited since", async () => {
    const { monitors } = await repository();
    const first = await monitors.create(site);
    clock += 1000;
    const second = await monitors.create(mail);
    clock += 1000;
    await monitors.update(first.id, { ...site, name: "معدّل" });
    await monitors.pause([first.id]);
    expect((await monitors.list()).map((m) => m.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  test("answers every monitor with its group and tags in one read", async () => {
    const { monitors } = await repository();
    await monitors.create(site);
    await monitors.create(mail);
    await monitors.create({ ...mail, group: "المهام", name: "ثالث", tags: [] });
    const listed = await monitors.list();
    expect(listed).toHaveLength(3);
    expect(listed.map((m) => [m.name, m.group, m.tags])).toEqual([
      ["الموقع", "الإنتاج", ["عام", "ويب"]],
      ["البريد", undefined, ["عام"]],
      ["ثالث", "المهام", []],
    ]);
  });

  test("a stored config that no longer fits the schema fails the read loudly rather than answering a half monitor", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    await runSql(location, "UPDATE monitors SET config = ? WHERE id = ?", [
      '{"type":"ping"}',
      "id-001",
    ]);
    await expect(monitors.list()).rejects.toThrow("id-001");
  });
});

describe("the command palette's choices", () => {
  test("are every monitor's id, name and target in creation order, a heartbeat monitor with no target", async () => {
    const { monitors } = await repository();
    const first = await monitors.create(site);
    clock += 1000;
    const second = await monitors.create(mail);
    clock += 1000;
    const third = await monitors.create({
      ...mail,
      config: {
        schedule: { everyMs: 300_000, kind: "every" },
        type: "heartbeat",
      },
      name: "النسخ الاحتياطي",
    });
    await monitors.pause([first.id]);
    expect(await monitors.choices()).toEqual([
      { id: first.id, name: "الموقع", target: "https://example.test/" },
      { id: second.id, name: "البريد", target: "mail.example.test:25" },
      { id: third.id, name: "النسخ الاحتياطي", target: undefined },
    ]);
  });

  test("are empty on an install with no monitor", async () => {
    const { monitors } = await repository();
    expect(await monitors.choices()).toEqual([]);
  });

  test("still name a monitor whose stored config no longer fits the schema, since they never read it", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    await runSql(location, "UPDATE monitors SET config = ? WHERE id = ?", [
      '{"type":"ping"}',
      "id-001",
    ]);
    expect(await monitors.choices()).toEqual([
      { id: "id-001", name: "الموقع", target: "https://example.test/" },
    ]);
  });
});

describe("the fields the monitor form adds", () => {
  test("a retention override is stored and read back, and absent stays absent", async () => {
    const { monitors } = await repository();
    const kept = await monitors.create({ ...site, retentionDays: 365 });
    expect(kept.retentionDays).toBe(365);
    expect((await monitors.find(kept.id))?.retentionDays).toBe(365);
    const plain = await monitors.create(mail);
    expect(plain.retentionDays).toBe(undefined);
    const edited = await monitors.update(plain.id, {
      ...mail,
      retentionDays: 7,
    });
    expect(edited?.retentionDays).toBe(7);
    expect((await monitors.update(plain.id, mail))?.retentionDays).toBe(
      undefined
    );
  });

  test("sealed credentials are stored beside the monitor and read by id and for every monitor, never on the monitor itself", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(site, "1.sealed-a");
    const b = await monitors.create(mail);
    expect(await monitors.credentialsOf(a.id)).toBe("1.sealed-a");
    expect(await monitors.credentialsOf(b.id)).toBe(undefined);
    expect(await monitors.credentialsOf("missing")).toBe(undefined);
    expect([...(await monitors.allCredentials())]).toEqual([
      [a.id, "1.sealed-a"],
    ]);
    const reads = [a, await monitors.find(a.id), ...(await monitors.list())];
    for (const monitor of reads) {
      expect(JSON.stringify(monitor).includes("sealed")).toBe(false);
    }
  });

  test("an edit replaces the sealed credentials, and an edit with none clears them", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(site, "1.first");
    await monitors.update(a.id, site, "1.second");
    expect(await monitors.credentialsOf(a.id)).toBe("1.second");
    await monitors.update(a.id, site);
    expect(await monitors.credentialsOf(a.id)).toBe(undefined);
    expect((await monitors.allCredentials()).size).toBe(0);
  });

  test("deleting a monitor deletes its sealed credentials with it", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(site, "1.sealed");
    await monitors.remove([a.id]);
    expect(await monitors.credentialsOf(a.id)).toBe(undefined);
    expect((await monitors.allCredentials()).size).toBe(0);
  });
});

const tokenShape = /^[\w-]{22}$/;

const beat: MonitorInput = {
  config: {
    schedule: { everyMs: 300_000, kind: "every" },
    type: "heartbeat",
  },
  intervalMs: 60_000,
  name: "النسخ الاحتياطي",
  retries: 2,
  channels: [],
  events: [...monitorEventKinds],
  tags: [],
  timeoutMs: 10_000,
};

describe("a heartbeat monitor's token", () => {
  test("a new heartbeat monitor gets a token of its own; another check type gets none", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(beat);
    const b = await monitors.create(beat);
    const c = await monitors.create(site);
    expect(await monitors.heartbeatTokenOf(a.id)).toBe(tokenNumber(1));
    expect(await monitors.heartbeatTokenOf(b.id)).toBe(tokenNumber(2));
    expect(await monitors.heartbeatTokenOf(c.id)).toBeUndefined();
    expect(await monitors.heartbeatTokenOf("missing")).toBeUndefined();
  });

  test("an edit keeps the token, so the job's URL goes on working", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(beat);
    await monitors.update(a.id, { ...beat, name: "renamed" });
    expect(await monitors.heartbeatTokenOf(a.id)).toBe(tokenNumber(1));
  });

  test("an edit asked to renew gives a new token and the old one is gone", async () => {
    const { location, monitors } = await repository();
    const a = await monitors.create(beat);
    await monitors.update(a.id, beat, undefined, { renewHeartbeatToken: true });
    expect(await monitors.heartbeatTokenOf(a.id)).toBe(tokenNumber(2));
    const rows = await runSql(
      location,
      `SELECT count(*) AS n FROM monitors WHERE heartbeat_token = '${tokenNumber(1)}'`
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  test("a monitor switched to another check type loses its token, and one switched to heartbeat gets one", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(beat);
    await monitors.update(a.id, site);
    expect(await monitors.heartbeatTokenOf(a.id)).toBeUndefined();
    await monitors.update(a.id, beat);
    expect(await monitors.heartbeatTokenOf(a.id)).toBe(tokenNumber(2));
  });

  test("renewing is ignored for another check type", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(site);
    await monitors.update(a.id, site, undefined, { renewHeartbeatToken: true });
    expect(await monitors.heartbeatTokenOf(a.id)).toBeUndefined();
  });

  test("the token is never part of the monitor the list and the scheduler read", async () => {
    const { monitors } = await repository();
    const a = await monitors.create(beat);
    expect(JSON.stringify(await monitors.list())).not.toContain(tokenNumber(1));
    expect(JSON.stringify(a)).not.toContain(tokenNumber(1));
  });

  test("a real token is 16 random bytes as base64url, 22 characters, different each time", () => {
    const tokens = Array.from({ length: 50 }, () => newHeartbeatToken());
    for (const token of tokens) {
      expect(token).toMatch(tokenShape);
      expect(Buffer.from(token, "base64url").length).toBe(16);
    }
    expect(new Set(tokens).size).toBe(50);
  });
});

describe("a monitor's events and reminder", () => {
  test("the events switched on and the reminder are stored and read back, and an edit replaces both", async () => {
    const { monitors } = await repository();
    const created = await monitors.create({
      ...site,
      events: ["down", "certificate_expiring"],
      reminderMs: 3_600_000,
    });
    expect(created.events).toEqual(["down", "certificate_expiring"]);
    expect(created.reminderMs).toBe(3_600_000);
    const found = await monitors.find(created.id);
    expect(found?.events).toEqual(["down", "certificate_expiring"]);
    expect(found?.reminderMs).toBe(3_600_000);
    const retimed = await monitors.update(created.id, {
      ...site,
      reminderMs: 900_000,
    });
    expect(retimed?.reminderMs).toBe(900_000);
    const edited = await monitors.update(created.id, {
      ...site,
      events: [],
    });
    expect(edited?.events).toEqual([]);
    expect(edited?.reminderMs).toBe(undefined);
  });

  test("a monitor stored before the events existed reads with all five on and no reminder", async () => {
    const { location, monitors } = await repository();
    await runSql(
      location,
      "INSERT INTO monitors (id, name, check_type, target, config, interval_ms, timeout_ms, retries, paused, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "old",
        "Old",
        "tcp",
        "mail.example.test:25",
        JSON.stringify(mail.config),
        60_000,
        5000,
        0,
        0,
        clock,
        clock,
      ]
    );
    const old = await monitors.find("old");
    expect(old?.events).toEqual([...monitorEventKinds]);
    expect(old?.reminderMs).toBe(undefined);
  });

  test("a stored events column that no longer fits fails the read loudly, naming the monitor", async () => {
    const { location, monitors } = await repository();
    await monitors.create(site);
    await runSql(location, "UPDATE monitors SET events = ? WHERE id = ?", [
      '["paused"]',
      "id-001",
    ]);
    await expect(monitors.list()).rejects.toThrow("id-001");
  });
});

describe("the selection bar's changes", () => {
  /** A channel stored beside the monitors, for them to select. */
  function channelNamed(name: string) {
    if (!open) {
      throw new Error("no repository");
    }
    return channelsRepository(executor(open.connection), () => clock).create({
      appliesToNew: false,
      config: {},
      locale: undefined,
      name,
      type: "webhook",
    });
  }

  const backup: MonitorInput = {
    ...mail,
    config: {
      schedule: { everyMs: 300_000, kind: "every" },
      type: "heartbeat",
    },
    name: "النسخ الاحتياطي",
    tags: [],
  };

  test("adding a channel selects it for the monitors that lack it, leaves the one that has it, and answers how many gained it", async () => {
    const { monitors } = await repository();
    const ops = await channelNamed("ops");
    const has = await monitors.create({ ...site, channels: [ops.id] });
    const lacks = await monitors.create(mail);
    const heartbeat = await monitors.create(backup);
    const ids = [has.id, lacks.id, heartbeat.id];
    clock += 1000;
    expect(await monitors.addChannel(ids, ops.id)).toBe(2);
    const listed = await monitors.list();
    expect(listed.map((monitor) => monitor.channels)).toEqual([
      [ops.id],
      [ops.id],
      [ops.id],
    ]);
    expect(listed.map((monitor) => monitor.updatedAt)).toEqual([
      clock - 1000,
      clock,
      clock,
    ]);
    expect(await monitors.addChannel(ids, ops.id)).toBe(0);
  });

  test("adding a channel leaves the monitors' events as they are", async () => {
    const { monitors } = await repository();
    const ops = await channelNamed("ops");
    const quiet = await monitors.create({ ...mail, events: ["down"] });
    await monitors.addChannel([quiet.id], ops.id);
    expect((await monitors.find(quiet.id))?.events).toEqual(["down"]);
  });

  test("a channel that does not exist is refused: nothing, and nothing written", async () => {
    const { location, monitors } = await repository();
    const created = await monitors.create(mail);
    clock += 1000;
    expect(await monitors.addChannel([created.id], "missing")).toBe(undefined);
    expect(await rowCount(location, "monitor_channels")).toBe(0);
    expect((await monitors.find(created.id))?.updatedAt).toBe(clock - 1000);
  });

  test("removing a channel drops it from the monitors that select it and answers how many did; the other channels stay", async () => {
    const { monitors } = await repository();
    const ops = await channelNamed("ops");
    const night = await channelNamed("night");
    const both = await monitors.create({
      ...site,
      channels: [ops.id, night.id],
    });
    const one = await monitors.create({ ...mail, channels: [ops.id] });
    const none = await monitors.create(backup);
    const ids = [both.id, one.id, none.id];
    clock += 1000;
    expect(await monitors.removeChannel(ids, ops.id)).toBe(2);
    const listed = await monitors.list();
    expect(listed.map((monitor) => monitor.channels)).toEqual([
      [night.id],
      [],
      [],
    ]);
    expect(listed.map((monitor) => monitor.updatedAt)).toEqual([
      clock,
      clock,
      clock - 1000,
    ]);
    expect(await monitors.removeChannel(ids, ops.id)).toBe(0);
    expect(await monitors.removeChannel(ids, "missing")).toBe(0);
  });

  test("setting the group moves the monitors not in it, creates it once, drops the group left empty, and answers how many changed group", async () => {
    const { location, monitors } = await repository();
    const inside = await monitors.create(site);
    const outside = await monitors.create(mail);
    const alone = await monitors.create({ ...backup, group: "الليل" });
    const ids = [inside.id, outside.id, alone.id];
    clock += 1000;
    expect(await monitors.setGroup(ids, "الإنتاج")).toBe(2);
    const listed = await monitors.list();
    expect(listed.map((monitor) => monitor.group)).toEqual([
      "الإنتاج",
      "الإنتاج",
      "الإنتاج",
    ]);
    expect(listed.map((monitor) => monitor.updatedAt)).toEqual([
      clock - 1000,
      clock,
      clock,
    ]);
    expect(await monitors.organization()).toEqual({
      groups: ["الإنتاج"],
      tags: ["عام", "ويب"],
    });
    expect(await monitors.setGroup(ids, "الإنتاج")).toBe(0);
    expect(await monitors.setGroup([inside.id, outside.id], "جديدة")).toBe(2);
    expect(await rowCount(location, "groups")).toBe(2);
  });

  test("setting no group takes the monitors out of theirs and drops the group left empty", async () => {
    const { location, monitors } = await repository();
    const inside = await monitors.create(site);
    const outside = await monitors.create(mail);
    expect(await monitors.setGroup([inside.id, outside.id], undefined)).toBe(1);
    expect((await monitors.find(inside.id))?.group).toBe(undefined);
    expect(await rowCount(location, "groups")).toBe(0);
  });

  test("adding a tag attaches it to the monitors that lack it, creating it once, and answers how many gained it", async () => {
    const { location, monitors } = await repository();
    const tagged = await monitors.create(site);
    const other = await monitors.create(mail);
    const heartbeat = await monitors.create(backup);
    const ids = [tagged.id, other.id, heartbeat.id];
    clock += 1000;
    expect(await monitors.addTag(ids, "ويب")).toBe(2);
    const listed = await monitors.list();
    expect(listed.map((monitor) => monitor.tags)).toEqual([
      ["عام", "ويب"],
      ["عام", "ويب"],
      ["ويب"],
    ]);
    expect(listed.map((monitor) => monitor.updatedAt)).toEqual([
      clock - 1000,
      clock,
      clock,
    ]);
    expect(await rowCount(location, "tags")).toBe(2);
    expect(await monitors.addTag(ids, "حرج")).toBe(3);
    expect(await rowCount(location, "tags")).toBe(3);
  });

  test("a tag a monitor has no room for is refused whole: nothing, and nothing written", async () => {
    const { location, monitors } = await repository();
    const room = await monitors.create(mail);
    const names = Array.from(
      { length: tagsMax },
      (_, index) => `t${String(index).padStart(2, "0")}`
    );
    const full = await monitors.create({ ...mail, tags: names });
    const ids = [room.id, full.id];
    expect(await monitors.addTag(ids, "حرج")).toBe(undefined);
    expect((await monitors.find(room.id))?.tags).toEqual(["عام"]);
    expect(await rowCount(location, "tags")).toBe(tagsMax + 1);
    // A full monitor that already carries the tag needs no room.
    expect(await monitors.addTag(ids, "t00")).toBe(1);
  });

  test("removing a tag drops it from the monitors that carry it, and the tag once no monitor carries it", async () => {
    const { location, monitors } = await repository();
    const tagged = await monitors.create(site);
    const other = await monitors.create(mail);
    const ids = [tagged.id, other.id];
    clock += 1000;
    expect(await monitors.removeTag(ids, "ويب")).toBe(1);
    expect(await monitors.organization()).toEqual({
      groups: ["الإنتاج"],
      tags: ["عام"],
    });
    expect((await monitors.find(other.id))?.updatedAt).toBe(clock - 1000);
    expect(await monitors.removeTag([tagged.id], "عام")).toBe(1);
    expect(await rowCount(location, "tags")).toBe(1);
    expect(await monitors.removeTag(ids, "لا شيء")).toBe(0);
  });

  test("an unknown monitor id is skipped by every change", async () => {
    const { monitors } = await repository();
    const ops = await channelNamed("ops");
    const created = await monitors.create(mail);
    const ids = ["missing", created.id];
    expect(await monitors.addChannel(ids, ops.id)).toBe(1);
    expect(await monitors.removeChannel(ids, ops.id)).toBe(1);
    expect(await monitors.setGroup(ids, "الإنتاج")).toBe(1);
    expect(await monitors.addTag(ids, "حرج")).toBe(1);
    expect(await monitors.removeTag(ids, "حرج")).toBe(1);
    expect(await monitors.list()).toHaveLength(1);
  });
});
