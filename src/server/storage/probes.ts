/**
 * The probes repository (CONTEXT.md "Probe", "Probe token"): one row per
 * probe with the SHA-256 of its token, never the token, and what its last
 * contact said. Deleting a probe drops it from every monitor's locations.
 * Rows never leave this file: every answer is a `Probe` of shared/schemas.
 */
import { sql } from "drizzle-orm";
import type { Probe } from "@/shared/schemas/probe.ts";
import type { Executor } from "./connection.ts";

/** What a probe's request said about it: when, which build, and its last round trip. */
export interface ProbeContact {
  readonly at: number;
  readonly roundTripMs: number | undefined;
  readonly version: string | undefined;
}

export interface ProbesRepository {
  /** The probe whose token has this SHA-256, or nothing. */
  byTokenHash: (hash: string) => Promise<Probe | undefined>;
  /** Stores a new probe with its token's hash; answers it with its id. */
  create: (name: string, tokenHash: string) => Promise<Probe>;
  /** Every probe, in creation order. */
  list: () => Promise<Probe[]>;
  /** Deletes the probe and its place among every monitor's locations; answers whether it existed. */
  remove: (id: string) => Promise<boolean>;
  /** Replaces the probe's token hash, so the old token stops at once; nothing when the id is unknown. */
  replaceToken: (id: string, tokenHash: string) => Promise<Probe | undefined>;
  /** Records the probe's last contact. */
  seen: (id: string, contact: ProbeContact) => Promise<void>;
}

interface ProbeRow {
  created_at: number;
  id: string;
  last_seen_at: number | null;
  name: string;
  round_trip_ms: number | null;
  version: string | null;
}

export function probesRepository(
  executor: Executor,
  now: () => number,
  newId: () => string = () => Bun.randomUUIDv7()
): ProbesRepository {
  const { probes } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  const select = (where: ReturnType<typeof sql>) =>
    executor.rows<ProbeRow>(
      sql`SELECT ${probes.id} AS id, ${probes.name} AS name, ${probes.createdAt} AS created_at, ${probes.lastSeenAt} AS last_seen_at, ${probes.version} AS version, ${probes.roundTripMs} AS round_trip_ms FROM ${probes} ${where} ORDER BY ${probes.createdAt}, ${probes.id}`
    );
  const find = async (id: string) =>
    (await select(sql`WHERE ${probes.id} = ${id}`)).map(toProbe)[0];
  return {
    byTokenHash: async (hash) =>
      (await select(sql`WHERE ${probes.tokenHash} = ${hash}`)).map(toProbe)[0],
    create: async (name, tokenHash) => {
      const id = newId();
      await executor.run(
        sql`INSERT INTO ${probes} (${column("id")}, ${column("name")}, ${column("token_hash")}, ${column("created_at")}) VALUES (${id}, ${name}, ${tokenHash}, ${now()})`
      );
      const created = await find(id);
      if (!created) {
        throw new Error(`the probe ${id} was not stored`);
      }
      return created;
    },
    list: async () => (await select(sql``)).map(toProbe),
    remove: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${probes} WHERE ${probes.id} = ${id}`
      )) > 0,
    replaceToken: async (id, tokenHash) => {
      const changed = await executor.run(
        sql`UPDATE ${probes} SET ${column("token_hash")} = ${tokenHash} WHERE ${probes.id} = ${id}`
      );
      return changed > 0 ? await find(id) : undefined;
    },
    seen: async (id, contact) => {
      await executor.run(
        sql`UPDATE ${probes} SET ${column("last_seen_at")} = ${contact.at}, ${column("version")} = ${contact.version ?? null}, ${column("round_trip_ms")} = ${contact.roundTripMs ?? null} WHERE ${probes.id} = ${id}`
      );
    },
  };
}

function toProbe(row: ProbeRow): Probe {
  return {
    createdAt: row.created_at,
    id: row.id,
    lastSeenAt: row.last_seen_at ?? undefined,
    name: row.name,
    roundTripMs: row.round_trip_ms ?? undefined,
    version: row.version ?? undefined,
  };
}
