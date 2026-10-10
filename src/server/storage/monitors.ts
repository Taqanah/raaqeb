/**
 * The monitors repository (CONTEXT.md "Monitor", "Group", "Tag"
 * organization, 5.2): one aggregate, three tables. A group or a tag exists
 * while a monitor carries its name; saving a monitor with a new name creates
 * the row, and the last monitor to drop a name removes it, so the list's
 * filters never offer an empty one. The channels a monitor selects are its
 * own rows beside it; deleting either side drops the link. Rows never leave this file: every answer
 * is a `Monitor` of shared/schemas.
 */
import { inArray, type SQL, sql } from "drizzle-orm";
import { targetOf } from "@/shared/domain/monitors.ts";
import {
  type Monitor,
  type MonitorChoice,
  type MonitorFields,
  monitorConfigSchema,
  monitorFieldsSchema,
  tagsMax,
} from "@/shared/schemas/monitor.ts";
import type { Executor } from "./connection.ts";

export interface MonitorsRepository {
  /** Selects the channel for those of these monitors that lack it; answers how many gained it, or nothing when no channel has that id. Unknown monitor ids are skipped. */
  addChannel: (
    ids: readonly string[],
    channelId: string
  ) => Promise<number | undefined>;
  /** Attaches the tag to those of these monitors that lack it, creating it on first use; answers how many gained it, or nothing, with nothing written, when one of them already carries as many tags as a monitor may. */
  addTag: (ids: readonly string[], name: string) => Promise<number | undefined>;
  /** Every monitor's sealed credentials by id; a monitor without any is absent. */
  allCredentials: () => Promise<ReadonlyMap<string, string>>;
  /** Every monitor's id, name and target, in creation order: one query with no join, for the command palette. */
  choices: () => Promise<MonitorChoice[]>;
  /** Stores a new monitor, active, with its sealed credentials and, for a heartbeat monitor, a new token; answers it with its id. */
  create: (input: MonitorFields, credentials?: string) => Promise<Monitor>;
  /** The monitor's sealed credentials, or nothing when it has none or does not exist. */
  credentialsOf: (id: string) => Promise<string | undefined>;
  /** The monitor with that id, or nothing. */
  find: (id: string) => Promise<Monitor | undefined>;
  /** A heartbeat monitor's token, or nothing for another check type or an unknown id. */
  heartbeatTokenOf: (id: string) => Promise<string | undefined>;
  /** Every monitor, with its group and tags, in creation order. */
  list: () => Promise<Monitor[]>;
  /** The group and tag names in use, each list in code point order. */
  organization: () => Promise<{ groups: string[]; tags: string[] }>;
  /** Stops the checks of these monitors; answers how many rows changed state. Unknown ids are skipped. */
  pause: (ids: readonly string[]) => Promise<number>;
  /** Deletes these monitors and answers how many existed. Unknown ids are skipped. */
  remove: (ids: readonly string[]) => Promise<number>;
  /** Drops the channel from those of these monitors that select it; answers how many did. */
  removeChannel: (ids: readonly string[], channelId: string) => Promise<number>;
  /** Drops the tag from those of these monitors that carry it, and the tag when no monitor carries it any more; answers how many did. */
  removeTag: (ids: readonly string[], name: string) => Promise<number>;
  /** Lets the checks of these monitors run again; answers how many rows changed state. */
  resume: (ids: readonly string[]) => Promise<number>;
  /** Moves these monitors into the group, creating it on first use, or with no name out of theirs, and drops a group left empty; answers how many changed group. */
  setGroup: (
    ids: readonly string[],
    name: string | undefined
  ) => Promise<number>;
  /** Replaces every field of the monitor and its sealed credentials (none clears them), keeping its id and paused state; nothing when the id is unknown. A heartbeat monitor keeps its token unless asked to renew it, gets one when it had none, and any other check type has none. */
  update: (
    id: string,
    input: MonitorFields,
    credentials?: string,
    options?: { readonly renewHeartbeatToken?: boolean }
  ) => Promise<Monitor | undefined>;
}

/** Thrown by a read when a stored config or events list no longer fits the schema; the message names the monitor, never the text. */
export class MonitorShapeError extends Error {
  readonly monitorId: string;
  constructor(id: string) {
    super(
      `the stored config or events of the monitor ${id} do not fit their schema`
    );
    this.name = "MonitorShapeError";
    this.monitorId = id;
  }
}

/** A monitor row joined with its group's name. */
interface MonitorRow {
  check_type: string;
  config: string;
  created_at: number;
  degraded_ms: number | null;
  description: string | null;
  events: string;
  group_name: string | null;
  id: string;
  interval_ms: number;
  name: string;
  paused: number;
  paused_at: number | null;
  reminder_ms: number | null;
  retention_days: number | null;
  retries: number;
  target: string | null;
  timeout_ms: number;
  updated_at: number;
}

/**
 * Ids are UUIDv7 text generated here; `newId` is a parameter so a
 * test can fix them. Every write that touches more than one table runs as
 * one transaction, so a failure half way leaves no orphan group, tag or
 * link behind.
 */
export function monitorsRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7(),
  newToken: () => string = newHeartbeatToken
): MonitorsRepository {
  const {
    channels,
    groups,
    monitorChannels,
    monitorTags,
    monitors,
    outages,
    tags,
  } = executor.tables;
  const column = (name: string) => sql.identifier(name);

  const selectMonitors = (run: Executor, where: ReturnType<typeof sql>) =>
    run.rows<MonitorRow>(
      sql`SELECT ${monitors.id} AS id, ${monitors.name} AS name, ${monitors.description} AS description, ${monitors.checkType} AS check_type, ${monitors.target} AS target, ${monitors.config} AS config, ${monitors.intervalMs} AS interval_ms, ${monitors.timeoutMs} AS timeout_ms, ${monitors.retries} AS retries, ${monitors.degradedMs} AS degraded_ms, ${monitors.retentionDays} AS retention_days, ${monitors.events} AS events, ${monitors.reminderMs} AS reminder_ms, ${monitors.paused} AS paused, ${monitors.pausedAt} AS paused_at, ${monitors.createdAt} AS created_at, ${monitors.updatedAt} AS updated_at, ${groups.name} AS group_name FROM ${monitors} LEFT JOIN ${groups} ON ${groups.id} = ${monitors.groupId} ${where} ORDER BY ${monitors.createdAt}, ${monitors.id}`
    );

  /** The tags of these monitors, by monitor id, in code point order. */
  const tagsOf = async (
    run: Executor,
    ids: readonly string[]
  ): Promise<Map<string, string[]>> => {
    const byMonitor = new Map<string, string[]>();
    if (ids.length === 0) {
      return byMonitor;
    }
    const rows = await run.rows<{ monitor_id: string; name: string }>(
      sql`SELECT ${monitorTags.monitorId} AS monitor_id, ${tags.name} AS name FROM ${monitorTags} JOIN ${tags} ON ${tags.id} = ${monitorTags.tagId} WHERE ${inArray(monitorTags.monitorId, [...ids])}`
    );
    for (const row of rows) {
      const names = byMonitor.get(row.monitor_id) ?? [];
      names.push(row.name);
      byMonitor.set(row.monitor_id, names);
    }
    for (const names of byMonitor.values()) {
      names.sort(compareCodePoints);
    }
    return byMonitor;
  };

  /** The channels these monitors select, by monitor id, in id order. */
  const channelsOf = async (
    run: Executor,
    ids: readonly string[]
  ): Promise<Map<string, string[]>> => {
    const byMonitor = new Map<string, string[]>();
    if (ids.length === 0) {
      return byMonitor;
    }
    const rows = await run.rows<{ channel_id: string; monitor_id: string }>(
      sql`SELECT ${monitorChannels.monitorId} AS monitor_id, ${monitorChannels.channelId} AS channel_id FROM ${monitorChannels} WHERE ${inArray(monitorChannels.monitorId, [...ids])}`
    );
    for (const row of rows) {
      const selected = byMonitor.get(row.monitor_id) ?? [];
      selected.push(row.channel_id);
      byMonitor.set(row.monitor_id, selected);
    }
    for (const selected of byMonitor.values()) {
      selected.sort(compareCodePoints);
    }
    return byMonitor;
  };

  const read = async (
    run: Executor,
    where: ReturnType<typeof sql>
  ): Promise<Monitor[]> => {
    const rows = await selectMonitors(run, where);
    const ids = rows.map((row) => row.id);
    const [tagNames, selected] = await Promise.all([
      tagsOf(run, ids),
      channelsOf(run, ids),
    ]);
    return rows.map((row) =>
      toMonitor(row, tagNames.get(row.id) ?? [], selected.get(row.id) ?? [])
    );
  };

  const findOne = async (
    run: Executor,
    id: string
  ): Promise<Monitor | undefined> => {
    const [found] = await read(run, sql`WHERE ${monitors.id} = ${id}`);
    return found;
  };

  /** The group's id, creating the row on its first use. */
  const groupIdFor = async (run: Executor, name: string | undefined) => {
    if (name === undefined) {
      return null;
    }
    const [found] = await run.rows<{ id: string }>(
      sql`SELECT ${groups.id} AS id FROM ${groups} WHERE ${groups.name} = ${name}`
    );
    if (found) {
      return found.id;
    }
    const id = newId();
    await run.run(
      sql`INSERT INTO ${groups} (${column("id")}, ${column("name")}, ${column("created_at")}) VALUES (${id}, ${name}, ${now()})`
    );
    return id;
  };

  /** Replaces the monitor's tag links with these names, creating tag rows on first use. */
  const linkTags = async (
    run: Executor,
    monitorId: string,
    names: readonly string[]
  ) => {
    await run.run(
      sql`DELETE FROM ${monitorTags} WHERE ${monitorTags.monitorId} = ${monitorId}`
    );
    const wanted = [...new Set(names)];
    if (wanted.length === 0) {
      return;
    }
    await run.run(
      sql`INSERT INTO ${tags} (${column("id")}, ${column("name")}) VALUES ${sql.join(
        wanted.map((name) => sql`(${newId()}, ${name})`),
        sql`, `
      )} ON CONFLICT (${column("name")}) DO NOTHING`
    );
    const rows = await run.rows<{ id: string }>(
      sql`SELECT ${tags.id} AS id FROM ${tags} WHERE ${inArray(tags.name, wanted)}`
    );
    await run.run(
      sql`INSERT INTO ${monitorTags} (${column("monitor_id")}, ${column("tag_id")}) VALUES ${sql.join(
        rows.map((row) => sql`(${monitorId}, ${row.id})`),
        sql`, `
      )}`
    );
  };

  /** Replaces the monitor's channel selection; a channel that no longer exists is skipped. */
  const linkChannels = async (
    run: Executor,
    monitorId: string,
    ids: readonly string[]
  ) => {
    await run.run(
      sql`DELETE FROM ${monitorChannels} WHERE ${monitorChannels.monitorId} = ${monitorId}`
    );
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return;
    }
    await run.run(
      sql`INSERT INTO ${monitorChannels} (${column("monitor_id")}, ${column("channel_id")}) SELECT ${monitorId}, ${channels.id} FROM ${channels} WHERE ${inArray(channels.id, wanted)}`
    );
  };

  /** Drops every group and tag no monitor carries any more. */
  const pruneEmpty = async (run: Executor) => {
    await run.run(
      sql`DELETE FROM ${groups} WHERE ${groups.id} NOT IN (SELECT ${monitors.groupId} FROM ${monitors} WHERE ${monitors.groupId} IS NOT NULL)`
    );
    await run.run(
      sql`DELETE FROM ${tags} WHERE ${tags.id} NOT IN (SELECT ${monitorTags.tagId} FROM ${monitorTags})`
    );
  };

  /** Flips the paused flag of the named monitors not already in that state, with the time it was paused; answers how many. */
  const setPaused = (ids: readonly string[], paused: boolean) =>
    executor.transaction(async (tx) => {
      if (ids.length === 0) {
        return 0;
      }
      const due = await tx.rows<{ id: string }>(
        sql`SELECT ${monitors.id} AS id FROM ${monitors} WHERE ${inArray(monitors.id, [...ids])} AND ${monitors.paused} = ${paused ? 0 : 1}`
      );
      if (due.length === 0) {
        return 0;
      }
      const time = now();
      const changed = due.map((row) => row.id);
      await tx.run(
        sql`UPDATE ${monitors} SET ${column("paused")} = ${paused ? 1 : 0}, ${column("paused_at")} = ${paused ? time : null}, ${column("updated_at")} = ${time} WHERE ${inArray(monitors.id, changed)}`
      );
      if (paused) {
        // Paused time is never downtime: the open outage ends when the row says the monitor was paused, in the same write.
        await tx.run(
          sql`UPDATE ${outages} SET ${column("ended_at")} = ${time} WHERE ${inArray(outages.monitorId, changed)} AND ${outages.endedAt} IS NULL`
        );
      }
      return due.length;
    });

  /** Moves the update time of those of these monitors the condition holds for; answers how many, the monitors a change reaches. */
  const touch = (run: Executor, ids: readonly string[], when: SQL) =>
    run.run(
      sql`UPDATE ${monitors} SET ${column("updated_at")} = ${now()} WHERE ${inArray(monitors.id, [...ids])} AND ${when}`
    );
  const selects = (channelId: string) =>
    sql`EXISTS (SELECT 1 FROM ${monitorChannels} WHERE ${monitorChannels.monitorId} = ${monitors.id} AND ${monitorChannels.channelId} = ${channelId})`;
  const carries = (tagId: string) =>
    sql`EXISTS (SELECT 1 FROM ${monitorTags} WHERE ${monitorTags.monitorId} = ${monitors.id} AND ${monitorTags.tagId} = ${tagId})`;
  const tagIdOf = async (run: Executor, name: string) => {
    const [row] = await run.rows<{ id: string }>(
      sql`SELECT ${tags.id} AS id FROM ${tags} WHERE ${tags.name} = ${name}`
    );
    return row?.id;
  };

  return {
    addChannel: (ids, channelId) =>
      executor.transaction(async (tx) => {
        const [channel] = await tx.rows<{ id: string }>(
          sql`SELECT ${channels.id} AS id FROM ${channels} WHERE ${channels.id} = ${channelId}`
        );
        if (!channel) {
          return;
        }
        const lacks = sql`NOT ${selects(channelId)}`;
        const count = await touch(tx, ids, lacks);
        await tx.run(
          sql`INSERT INTO ${monitorChannels} (${column("monitor_id")}, ${column("channel_id")}) SELECT ${monitors.id}, ${channelId} FROM ${monitors} WHERE ${inArray(monitors.id, [...ids])} AND ${lacks}`
        );
        return count;
      }),
    addTag: (ids, name) =>
      executor.transaction(async (tx) => {
        const lacks = sql`NOT EXISTS (SELECT 1 FROM ${monitorTags} JOIN ${tags} ON ${tags.id} = ${monitorTags.tagId} WHERE ${monitorTags.monitorId} = ${monitors.id} AND ${tags.name} = ${name})`;
        const [full] = await tx.rows<{ id: string }>(
          sql`SELECT ${monitors.id} AS id FROM ${monitors} WHERE ${inArray(monitors.id, [...ids])} AND ${lacks} AND (SELECT COUNT(*) FROM ${monitorTags} WHERE ${monitorTags.monitorId} = ${monitors.id}) >= ${tagsMax}`
        );
        if (full) {
          return;
        }
        const count = await touch(tx, ids, lacks);
        if (count === 0) {
          return 0;
        }
        const tagId = (await tagIdOf(tx, name)) ?? newId();
        await tx.run(
          sql`INSERT INTO ${tags} (${column("id")}, ${column("name")}) VALUES (${tagId}, ${name}) ON CONFLICT (${column("name")}) DO NOTHING`
        );
        await tx.run(
          sql`INSERT INTO ${monitorTags} (${column("monitor_id")}, ${column("tag_id")}) SELECT ${monitors.id}, ${tagId} FROM ${monitors} WHERE ${inArray(monitors.id, [...ids])} AND NOT ${carries(tagId)}`
        );
        return count;
      }),
    allCredentials: async () => {
      const rows = await executor.rows<{ credentials: string; id: string }>(
        sql`SELECT ${monitors.id} AS id, ${monitors.credentials} AS credentials FROM ${monitors} WHERE ${monitors.credentials} IS NOT NULL`
      );
      return new Map(rows.map((row) => [row.id, row.credentials]));
    },
    choices: async () => {
      const rows = await executor.rows<{
        id: string;
        name: string;
        target: string | null;
      }>(
        sql`SELECT ${monitors.id} AS id, ${monitors.name} AS name, ${monitors.target} AS target FROM ${monitors} ORDER BY ${monitors.createdAt}, ${monitors.id}`
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        target: row.target ?? undefined,
      }));
    },
    create: (input, credentials) =>
      executor.transaction(async (tx) => {
        const id = newId();
        const time = now();
        const groupId = await groupIdFor(tx, input.group);
        await tx.run(
          sql`INSERT INTO ${monitors} (${column("id")}, ${column("name")}, ${column("description")}, ${column("check_type")}, ${column("target")}, ${column("config")}, ${column("interval_ms")}, ${column("timeout_ms")}, ${column("retries")}, ${column("degraded_ms")}, ${column("retention_days")}, ${column("events")}, ${column("reminder_ms")}, ${column("credentials")}, ${column("heartbeat_token")}, ${column("paused")}, ${column("group_id")}, ${column("created_at")}, ${column("updated_at")}) VALUES (${id}, ${input.name}, ${input.description ?? null}, ${input.config.type}, ${targetOf(input.config) ?? null}, ${JSON.stringify(input.config)}, ${input.intervalMs}, ${input.timeoutMs}, ${input.retries}, ${input.degradedMs ?? null}, ${input.retentionDays ?? null}, ${JSON.stringify(input.events)}, ${input.reminderMs ?? null}, ${credentials ?? null}, ${input.config.type === "heartbeat" ? newToken() : null}, ${0}, ${groupId}, ${time}, ${time})`
        );
        await linkTags(tx, id, input.tags);
        await linkChannels(tx, id, input.channels);
        const created = await findOne(tx, id);
        if (!created) {
          throw new Error(`the monitor ${id} was not stored`);
        }
        return created;
      }),
    credentialsOf: async (id) => {
      const [row] = await executor.rows<{ credentials: string | null }>(
        sql`SELECT ${monitors.credentials} AS credentials FROM ${monitors} WHERE ${monitors.id} = ${id}`
      );
      return row?.credentials ?? undefined;
    },
    find: (id) => findOne(executor, id),
    heartbeatTokenOf: async (id) => {
      const [row] = await executor.rows<{ token: string | null }>(
        sql`SELECT ${monitors.heartbeatToken} AS token FROM ${monitors} WHERE ${monitors.id} = ${id}`
      );
      return row?.token ?? undefined;
    },
    list: () => read(executor, sql``),
    organization: async () => {
      const [groupRows, tagRows] = await Promise.all([
        executor.rows<{ name: string }>(
          sql`SELECT ${groups.name} AS name FROM ${groups}`
        ),
        executor.rows<{ name: string }>(
          sql`SELECT ${tags.name} AS name FROM ${tags}`
        ),
      ]);
      const names = (rows: { name: string }[]) =>
        rows.map((row) => row.name).sort(compareCodePoints);
      return { groups: names(groupRows), tags: names(tagRows) };
    },
    pause: (ids) => setPaused(ids, true),
    remove: (ids) =>
      executor.transaction(async (tx) => {
        if (ids.length === 0) {
          return 0;
        }
        const existing = await tx.rows<{ id: string }>(
          sql`SELECT ${monitors.id} AS id FROM ${monitors} WHERE ${inArray(monitors.id, [...ids])}`
        );
        if (existing.length === 0) {
          return 0;
        }
        await tx.run(
          sql`DELETE FROM ${monitors} WHERE ${inArray(
            monitors.id,
            existing.map((row) => row.id)
          )}`
        );
        await pruneEmpty(tx);
        return existing.length;
      }),
    removeChannel: (ids, channelId) =>
      executor.transaction(async (tx) => {
        const count = await touch(tx, ids, selects(channelId));
        await tx.run(
          sql`DELETE FROM ${monitorChannels} WHERE ${monitorChannels.channelId} = ${channelId} AND ${inArray(monitorChannels.monitorId, [...ids])}`
        );
        return count;
      }),
    removeTag: (ids, name) =>
      executor.transaction(async (tx) => {
        const tagId = await tagIdOf(tx, name);
        if (tagId === undefined) {
          return 0;
        }
        const count = await touch(tx, ids, carries(tagId));
        await tx.run(
          sql`DELETE FROM ${monitorTags} WHERE ${monitorTags.tagId} = ${tagId} AND ${inArray(monitorTags.monitorId, [...ids])}`
        );
        await pruneEmpty(tx);
        return count;
      }),
    resume: (ids) => setPaused(ids, false),
    setGroup: (ids, name) =>
      executor.transaction(async (tx) => {
        const groupId = await groupIdFor(tx, name);
        const elsewhere =
          groupId === null
            ? sql`${monitors.groupId} IS NOT NULL`
            : sql`(${monitors.groupId} IS NULL OR ${monitors.groupId} <> ${groupId})`;
        const count = await tx.run(
          sql`UPDATE ${monitors} SET ${column("group_id")} = ${groupId}, ${column("updated_at")} = ${now()} WHERE ${inArray(monitors.id, [...ids])} AND ${elsewhere}`
        );
        await pruneEmpty(tx);
        return count;
      }),
    update: (id, input, credentials, options) =>
      executor.transaction(async (tx) => {
        const [existing] = await tx.rows<{ token: string | null }>(
          sql`SELECT ${monitors.heartbeatToken} AS token FROM ${monitors} WHERE ${monitors.id} = ${id}`
        );
        if (!existing) {
          return;
        }
        // A heartbeat monitor keeps its URL unless asked to renew it; any other check type has none.
        let token: string | null = null;
        if (input.config.type === "heartbeat") {
          token =
            existing.token === null || options?.renewHeartbeatToken
              ? newToken()
              : existing.token;
        }
        const groupId = await groupIdFor(tx, input.group);
        await tx.run(
          sql`UPDATE ${monitors} SET ${column("name")} = ${input.name}, ${column("description")} = ${input.description ?? null}, ${column("check_type")} = ${input.config.type}, ${column("target")} = ${targetOf(input.config) ?? null}, ${column("config")} = ${JSON.stringify(input.config)}, ${column("interval_ms")} = ${input.intervalMs}, ${column("timeout_ms")} = ${input.timeoutMs}, ${column("retries")} = ${input.retries}, ${column("degraded_ms")} = ${input.degradedMs ?? null}, ${column("retention_days")} = ${input.retentionDays ?? null}, ${column("events")} = ${JSON.stringify(input.events)}, ${column("reminder_ms")} = ${input.reminderMs ?? null}, ${column("credentials")} = ${credentials ?? null}, ${column("heartbeat_token")} = ${token}, ${column("group_id")} = ${groupId}, ${column("updated_at")} = ${now()} WHERE ${monitors.id} = ${id}`
        );
        await linkTags(tx, id, input.tags);
        await linkChannels(tx, id, input.channels);
        await pruneEmpty(tx);
        return findOne(tx, id);
      }),
  };
}

/** A heartbeat monitor's token: 16 random bytes as base64url. */
export function newHeartbeatToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64url"
  );
}

function toMonitor(
  row: MonitorRow,
  tagNames: string[],
  channelIds: string[]
): Monitor {
  const config = monitorConfigSchema.safeParse(parseJson(row.config));
  const events = monitorFieldsSchema.shape.events.safeParse(
    parseJson(row.events)
  );
  if (!(config.success && events.success)) {
    throw new MonitorShapeError(row.id);
  }
  return {
    config: config.data,
    createdAt: row.created_at,
    degradedMs: row.degraded_ms ?? undefined,
    description: row.description ?? undefined,
    events: events.data,
    group: row.group_name ?? undefined,
    id: row.id,
    intervalMs: row.interval_ms,
    name: row.name,
    paused: row.paused !== 0,
    pausedAt: row.paused_at ?? undefined,
    reminderMs: row.reminder_ms ?? undefined,
    retentionDays: row.retention_days ?? undefined,
    retries: row.retries,
    channels: channelIds,
    tags: tagNames,
    target: row.target ?? undefined,
    timeoutMs: row.timeout_ms,
    updatedAt: row.updated_at,
  };
}

/** Plain code unit order: the same on both backends and in the browser, whatever the database collation. */
function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
