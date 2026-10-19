/**
 * The domain registrations repository (CONTEXT.md "Domain registration"):
 * one row per monitor, written whole by the registration pass at each read.
 * Rows never leave this file.
 */
import { sql } from "drizzle-orm";
import type { DomainRegistration } from "@/shared/schemas/registration.ts";
import type { Executor } from "./connection.ts";

export interface RegistrationsRepository {
  /** The registration of one monitor, or nothing. */
  find: (monitorId: string) => Promise<DomainRegistration | undefined>;
  /** Every registration, for the pass over the monitors. */
  list: () => Promise<DomainRegistration[]>;
  /** Drops a monitor's registration, if any; the pass is then due for it. */
  remove: (monitorId: string) => Promise<void>;
  /** Stores a read, replacing the monitor's previous registration whole; the warning already sent stays while the expiry date is the same. */
  replace: (record: Omit<DomainRegistration, "warned">) => Promise<void>;
  /** Records that the registration expiring at `expiresAt` got its warning; answers whether that is still the monitor's expiry date. */
  warned: (monitorId: string, expiresAt: number) => Promise<boolean>;
}

/** A row as the driver answers it. */
interface RegistrationRow {
  domain: string | null;
  expires_at: number | null;
  monitor_id: string;
  read_at: number;
  warned: number;
}

export function registrationsRepository(
  executor: Executor
): RegistrationsRepository {
  const { domainRegistrations: table } = executor.tables;
  const columns = sql`${table.monitorId} AS monitor_id, ${table.domain} AS domain, ${table.expiresAt} AS expires_at, ${table.readAt} AS read_at, ${table.warned} AS warned`;
  const excluded = (column: string) =>
    sql`${sql.identifier("excluded")}.${sql.identifier(column)}`;

  return {
    find: async (monitorId) => {
      const [row] = await executor.rows<RegistrationRow>(
        sql`SELECT ${columns} FROM ${table} WHERE ${table.monitorId} = ${monitorId}`
      );
      return row ? recordOf(row) : undefined;
    },
    list: async () => {
      const rows = await executor.rows<RegistrationRow>(
        sql`SELECT ${columns} FROM ${table}`
      );
      return rows.map(recordOf);
    },
    remove: async (monitorId) => {
      await executor.run(
        sql`DELETE FROM ${table} WHERE ${table.monitorId} = ${monitorId}`
      );
    },
    replace: async (record) => {
      // One upsert on the monitor's key, the same statement on both backends; an unknown date equals nothing, so it starts over too.
      await executor.run(
        sql`INSERT INTO ${table} (${sql.identifier("monitor_id")}, ${sql.identifier("domain")}, ${sql.identifier("expires_at")}, ${sql.identifier("read_at")}) VALUES (${record.monitorId}, ${record.domain ?? null}, ${record.expiresAt ?? null}, ${record.readAt}) ON CONFLICT (${sql.identifier("monitor_id")}) DO UPDATE SET ${sql.identifier("warned")} = CASE WHEN ${table.expiresAt} = ${excluded("expires_at")} THEN ${table.warned} ELSE 0 END, ${sql.identifier("domain")} = ${excluded("domain")}, ${sql.identifier("expires_at")} = ${excluded("expires_at")}, ${sql.identifier("read_at")} = ${excluded("read_at")}`
      );
    },
    warned: async (monitorId, expiresAt) => {
      const changed = await executor.run(
        sql`UPDATE ${table} SET ${sql.identifier("warned")} = 1 WHERE ${table.monitorId} = ${monitorId} AND ${table.expiresAt} = ${expiresAt}`
      );
      return changed > 0;
    },
  };
}

function recordOf(row: RegistrationRow): DomainRegistration {
  return {
    domain: row.domain ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    monitorId: row.monitor_id,
    readAt: row.read_at,
    warned: row.warned !== 0,
  };
}
