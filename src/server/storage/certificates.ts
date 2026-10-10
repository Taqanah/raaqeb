/**
 * The certificate records repository (CONTEXT.md "Certificate record"): one row per monitor, written whole by the reader and replaced when
 * the fingerprint changes. Rows never leave this file.
 */
import { sql } from "drizzle-orm";
import {
  type CertificateRecord,
  type CertificateWarning,
  certificateNamesSchema,
  certificateWarnings,
} from "@/shared/schemas/certificate.ts";
import type { Executor } from "./connection.ts";

export interface CertificatesRepository {
  /** The record of one monitor, or nothing. */
  find: (monitorId: string) => Promise<CertificateRecord | undefined>;
  /** Every record, for the reader's pass over the monitors. */
  list: () => Promise<CertificateRecord[]>;
  /** Drops a monitor's record, if any; the reader is then due for it. */
  remove: (monitorId: string) => Promise<void>;
  /** Stores the record, replacing the monitor's previous one whole; the warning already sent stays while the fingerprint is the same. */
  replace: (record: CertificateRecord) => Promise<void>;
  /** Records that the certificate with this fingerprint got the warning; answers whether it is still the monitor's certificate. */
  warned: (
    monitorId: string,
    fingerprint: string,
    warning: CertificateWarning
  ) => Promise<boolean>;
}

/** Thrown by a read when a stored record no longer fits its schema; the message names the monitor, never the text. */
export class CertificateShapeError extends Error {
  readonly monitorId: string;
  constructor(monitorId: string) {
    super(
      `the stored certificate record of the monitor ${monitorId} does not fit its schema`
    );
    this.name = "CertificateShapeError";
    this.monitorId = monitorId;
  }
}

/** A row as the driver answers it. */
interface CertificateRow {
  fingerprint: string;
  issuer: string;
  last_seen_at: number;
  monitor_id: string;
  names: string;
  subject: string;
  valid_from: number;
  valid_to: number;
  warned: number;
}

export function certificatesRepository(
  executor: Executor
): CertificatesRepository {
  const { certificateRecords: table } = executor.tables;
  const columns = sql`${table.monitorId} AS monitor_id, ${table.subject} AS subject, ${table.issuer} AS issuer, ${table.validFrom} AS valid_from, ${table.validTo} AS valid_to, ${table.names} AS names, ${table.fingerprint} AS fingerprint, ${table.lastSeenAt} AS last_seen_at, ${table.warned} AS warned`;
  const excluded = (column: string) =>
    sql`${sql.identifier("excluded")}.${sql.identifier(column)}`;

  return {
    find: async (monitorId) => {
      const [row] = await executor.rows<CertificateRow>(
        sql`SELECT ${columns} FROM ${table} WHERE ${table.monitorId} = ${monitorId}`
      );
      return row ? recordOf(row) : undefined;
    },
    list: async () => {
      const rows = await executor.rows<CertificateRow>(
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
      // One upsert on the monitor's key, the same statement on both backends.
      await executor.run(
        sql`INSERT INTO ${table} (${sql.identifier("monitor_id")}, ${sql.identifier("subject")}, ${sql.identifier("issuer")}, ${sql.identifier("valid_from")}, ${sql.identifier("valid_to")}, ${sql.identifier("names")}, ${sql.identifier("fingerprint")}, ${sql.identifier("last_seen_at")}) VALUES (${record.monitorId}, ${record.subject}, ${record.issuer}, ${record.validFrom}, ${record.validTo}, ${JSON.stringify(record.names)}, ${record.fingerprint}, ${record.lastSeenAt}) ON CONFLICT (${sql.identifier("monitor_id")}) DO UPDATE SET ${sql.identifier("warned")} = CASE WHEN ${table.fingerprint} = ${excluded("fingerprint")} THEN ${table.warned} ELSE 0 END, ${sql.identifier("subject")} = ${excluded("subject")}, ${sql.identifier("issuer")} = ${excluded("issuer")}, ${sql.identifier("valid_from")} = ${excluded("valid_from")}, ${sql.identifier("valid_to")} = ${excluded("valid_to")}, ${sql.identifier("names")} = ${excluded("names")}, ${sql.identifier("fingerprint")} = ${excluded("fingerprint")}, ${sql.identifier("last_seen_at")} = ${excluded("last_seen_at")}`
      );
    },
    warned: async (monitorId, fingerprint, warning) => {
      const changed = await executor.run(
        sql`UPDATE ${table} SET ${sql.identifier("warned")} = ${certificateWarnings.indexOf(warning) + 1} WHERE ${table.monitorId} = ${monitorId} AND ${table.fingerprint} = ${fingerprint}`
      );
      return changed > 0;
    },
  };
}

function recordOf(row: CertificateRow): CertificateRecord {
  const names = certificateNamesSchema.safeParse(parseJson(row.names));
  // 0 is none; 1 and 2 are the warnings in their order.
  const warned =
    row.warned === 0 ? undefined : certificateWarnings[row.warned - 1];
  if (!names.success || (row.warned !== 0 && warned === undefined)) {
    throw new CertificateShapeError(row.monitor_id);
  }
  return {
    fingerprint: row.fingerprint,
    issuer: row.issuer,
    lastSeenAt: row.last_seen_at,
    monitorId: row.monitor_id,
    names: names.data,
    subject: row.subject,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    ...(warned && { warned }),
  };
}

/** Parsed JSON, or nothing for text that is not JSON; the schema decides after. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema refuses `undefined` and the error names the monitor.
  }
}
