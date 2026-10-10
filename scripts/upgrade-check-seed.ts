/**
 * The install `bun run upgrade:check` fills the old version with, as the
 * export file an operator would restore from: a monitor of every check type
 * and a channel of every kind, with history, an outage, sealed days, status
 * pages, incidents, a maintenance window, subscribers and settings. Every
 * moment is moved so the newest history ends at `now`, and every monitor is
 * paused, so no check reaches the network and nothing is written between the
 * two exports. An old version that lacks a check type or a channel kind is
 * named in `without`, and the seed holds none of it.
 */
import { exportInstall } from "@/server/export/export.ts";
import {
  checksEvery,
  day,
  fileOf,
  now as fixtureNow,
  hour,
  type Install,
  linesOf,
  minute,
  sourceInstall,
} from "@/server/export/fixture.ts";
import { sealCredentials } from "@/server/monitors/credentials.ts";
import { sealSecrets } from "@/server/notify/secrets.ts";
import { runSql } from "@/server/storage/fixture.ts";
import type { ChannelType } from "@/shared/schemas/channel.ts";
import type { MonitorConfig } from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import { shiftTimes } from "./upgrade-check-export.ts";

/** The channels the fixture lacks: its install holds a webhook and an email channel. */
const moreChannels: readonly {
  readonly config: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly type: ChannelType;
}[] = [
  {
    config: {},
    secrets: { url: "https://hooks.slack.com/services/T0000/B0000/abcdef" },
    type: "slack",
  },
  {
    config: {},
    secrets: { url: "https://discord.com/api/webhooks/123456/abcdef" },
    type: "discord",
  },
  {
    config: { chatId: "-1001234567890" },
    secrets: { botToken: "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOO-pqrs" },
    type: "telegram",
  },
  {
    config: { server: "https://ntfy.example.test" },
    secrets: { token: "tk_abcdef0123456789", topic: "raaqeb-alerts" },
    type: "ntfy",
  },
];

/** The monitors the fixture lacks: its install holds an HTTP, a DNS and a heartbeat monitor. A database monitor's connection URL is its credential. */
const moreMonitors: readonly {
  readonly config: MonitorConfig;
  readonly name: string;
  readonly url?: string;
}[] = [
  {
    config: { host: "db.example.test", port: 5432, type: "tcp" },
    name: "Database port",
  },
  {
    config: {
      address: "pg.example.test:5432",
      query: "SELECT 1",
      type: "postgres",
    },
    name: "Postgres",
    url: "postgres://raaqeb:pg-secret@pg.example.test:5432/app",
  },
  {
    config: { address: "my.example.test:3306", type: "mysql" },
    name: "MySQL",
    url: "mysql://raaqeb:my-secret@my.example.test:3306/app",
  },
  {
    config: { address: "cache.example.test:6379", type: "redis" },
    name: "Redis",
    url: "redis://:redis-secret@cache.example.test:6379/0",
  },
  {
    config: {
      container: "raaqeb-web",
      endpoint: "http://docker.example.test:2375",
      type: "docker",
    },
    name: "Web container",
  },
];

async function addChannels(
  source: Install,
  without: readonly string[]
): Promise<string[]> {
  return await Promise.all(
    moreChannels
      .filter(({ type }) => !without.includes(type))
      .map(async ({ config, secrets, type }) => {
        const channel = await source.storage.channels.create(
          {
            appliesToNew: false,
            config,
            locale: undefined,
            name: `Ops ${type}`,
            type,
          },
          await sealSecrets(source.key, secrets)
        );
        return channel.id;
      })
  );
}

/** Each monitor with a morning of checks, one in ten down, and an outage that ended. */
async function addMonitors(
  source: Install,
  channels: readonly string[],
  without: readonly string[]
): Promise<void> {
  const kept = moreMonitors.filter(
    ({ config }) => !without.includes(config.type)
  );
  for (const [index, { config, name, url }] of kept.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one monitor at a time, the order of their creation
    const monitor = await source.storage.monitors.create(
      {
        channels: channels.slice(index % channels.length).slice(0, 2),
        config,
        events: ["down", "recovered"],
        intervalMs: 5 * minute,
        name,
        retries: 1,
        tags: ["prod"],
        timeoutMs: 5000,
      },
      await sealCredentials(source.key, { headers: [], url })
    );
    await checksEvery(
      source.storage,
      monitor.id,
      fixtureNow - 4 * hour,
      fixtureNow,
      10 * minute
    );
    await runSql(
      source.location,
      "INSERT INTO outages (monitor_id, started_at, ended_at, reason, acknowledged_at) VALUES (?, ?, ?, ?, NULL)",
      [
        monitor.id,
        fixtureNow - 3 * hour,
        fixtureNow - 2 * hour,
        reasons.timeout,
      ]
    );
  }
}

/** The seed as a zstd-compressed export file. */
export async function seedFile(
  now: number,
  without: readonly string[] = []
): Promise<Uint8Array<ArrayBuffer>> {
  const source = await sourceInstall();
  try {
    source.at(fixtureNow - 150 * day);
    await addMonitors(source, await addChannels(source, without), without);
    const { storage } = source;
    source.at(fixtureNow);
    await storage.monitors.pause(
      (await storage.monitors.list()).map((monitor) => monitor.id)
    );
    // Pausing ends the monitor's open outage; the seed keeps the DNS monitor's open.
    await runSql(
      source.location,
      "UPDATE outages SET ended_at = NULL WHERE monitor_id = ?",
      [source.ids.dns]
    );
    const started = await exportInstall(
      storage,
      source.key,
      "full",
      fixtureNow
    );
    if (!started.ok) {
      throw new Error(`the seed could not be exported: ${started.reason}`);
    }
    // Whole days, so a day of history stays one UTC day.
    const delta = Math.floor((now - fixtureNow) / day) * day;
    const lines = shiftTimes(await linesOf(started.body), delta);
    return await new Response(
      fileOf(lines.map((line) => JSON.stringify(line)))
    ).bytes();
  } finally {
    await source.cleanup();
  }
}
