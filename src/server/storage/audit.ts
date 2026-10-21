/**
 * The audit log repository (CONTEXT.md "Audit entry"): entries are only
 * ever appended, read newest first in pages, and deleted only once past
 * retention. Nothing here changes an entry.
 */

import { type SQL, sql } from "drizzle-orm";
import type { AuditDetail, AuditEntry } from "@/shared/schemas/audit.ts";
import type { Executor } from "./connection.ts";
import { parseJson } from "./content.ts";

export interface AuditQuery {
  /** Only this account's entries. */
  readonly actorId?: string;
  /** Entries strictly older than this time. */
  readonly before?: number;
  /** Only actions with this target, the part before the dot. */
  readonly kind?: string;
  readonly limit: number;
}

export interface AuditRepository {
  /** Every account an entry names, with the email it had then, the newest email first. */
  actors: () => Promise<{ readonly email: string; readonly id: string }[]>;
  /** Writes one entry. */
  append: (entry: AuditEntry) => Promise<void>;
  /** Entries that match, newest first. */
  list: (query: AuditQuery) => Promise<AuditEntry[]>;
  /** Deletes the entries older than the time; answers how many went. */
  purgeBefore: (at: number) => Promise<number>;
}

interface Row {
  readonly action: string;
  readonly actor_email: string | null;
  readonly actor_id: string | null;
  readonly address: string | null;
  readonly at: number;
  readonly detail: string;
  readonly id: string;
  readonly target_id: string | null;
}

function detailOf(text: string): AuditDetail {
  const parsed: unknown = parseJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (pair): pair is [string, string | number | boolean] =>
        typeof pair[1] === "string" ||
        typeof pair[1] === "number" ||
        typeof pair[1] === "boolean"
    )
  );
}

function entryOf(row: Row): AuditEntry {
  return {
    action: row.action,
    actorEmail: row.actor_email,
    actorId: row.actor_id,
    address: row.address,
    at: Number(row.at),
    detail: detailOf(row.detail),
    id: row.id,
    targetId: row.target_id,
  };
}

export function auditRepository(executor: Executor): AuditRepository {
  const { auditEntries: audit } = executor.tables;
  const name = (column: { name: string }) => sql.identifier(column.name);
  return {
    actors: async () => {
      const rows = await executor.rows<{ id: string; email: string }>(
        sql`SELECT ${audit.actorId} AS id, ${audit.actorEmail} AS email FROM ${audit} WHERE ${audit.actorId} IS NOT NULL AND ${audit.actorEmail} IS NOT NULL ORDER BY ${audit.at} DESC`
      );
      const seen = new Map<string, string>();
      for (const row of rows) {
        if (!seen.has(row.id)) {
          seen.set(row.id, row.email);
        }
      }
      return [...seen].map(([id, email]) => ({ email, id }));
    },
    append: async (entry) => {
      await executor.run(
        sql`INSERT INTO ${audit} (${name(audit.id)}, ${name(audit.at)}, ${name(audit.actorId)}, ${name(audit.actorEmail)}, ${name(audit.action)}, ${name(audit.targetId)}, ${name(audit.detail)}, ${name(audit.address)}) VALUES (${entry.id}, ${entry.at}, ${entry.actorId}, ${entry.actorEmail}, ${entry.action}, ${entry.targetId}, ${JSON.stringify(entry.detail)}, ${entry.address})`
      );
    },
    list: async (query) => {
      const where: SQL[] = [sql`1 = 1`];
      if (query.actorId !== undefined) {
        where.push(sql`${audit.actorId} = ${query.actorId}`);
      }
      if (query.before !== undefined) {
        where.push(sql`${audit.at} < ${query.before}`);
      }
      if (query.kind !== undefined) {
        where.push(sql`${audit.action} LIKE ${`${query.kind}.%`}`);
      }
      const rows = await executor.rows<Row>(
        sql`SELECT ${audit.id} AS id, ${audit.at} AS at, ${audit.actorId} AS actor_id, ${audit.actorEmail} AS actor_email, ${audit.action} AS action, ${audit.targetId} AS target_id, ${audit.detail} AS detail, ${audit.address} AS address FROM ${audit} WHERE ${sql.join(where, sql` AND `)} ORDER BY ${audit.at} DESC, ${audit.id} DESC LIMIT ${query.limit}`
      );
      return rows.map(entryOf);
    },
    purgeBefore: (at) =>
      executor.run(sql`DELETE FROM ${audit} WHERE ${audit.at} < ${at}`),
  };
}
