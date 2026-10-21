/**
 * The audit log's module (CONTEXT.md "Audit entry"): writing an entry for
 * a change an operator made or a sign-in event, reading the log page, and
 * the nightly purge past the install's retention. Writing never throws and
 * never stops the change it records: a failed write is a log line.
 */
import { error as logError, reasonOf } from "@/server/log.ts";
import { readRetentionDays } from "@/server/settings/retention.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { detailOf, targetOf } from "@/shared/domain/audit.ts";
import {
  type AuditFilter,
  type AuditView,
  auditPageSize,
} from "@/shared/schemas/audit.ts";

export type AuditStorage = Pick<Storage, "audit">;

/** The account an entry is about, as it was then. */
export interface AuditActor {
  readonly email: string;
  readonly id: string;
}

export interface AuditEvent {
  readonly action: string;
  readonly actor: AuditActor | undefined;
  /** The client address behind the trusted proxies. */
  readonly address: string | undefined;
  /** The name of the management API key that made the change; none for a session's. */
  readonly apiKey?: string | undefined;
  /** What was asked, reduced to its secret-free scalar fields, and the record it names. */
  readonly input: unknown;
  readonly now: number;
}

/** Writes the entry; a failed write is logged, never thrown. */
export async function record(
  storage: AuditStorage,
  event: AuditEvent
): Promise<void> {
  try {
    await storage.audit.append({
      action: event.action,
      actorEmail: event.actor?.email ?? null,
      actorId: event.actor?.id ?? null,
      address: event.address ?? null,
      at: event.now,
      detail: {
        ...detailOf(event.input),
        ...(event.apiKey !== undefined && { via: event.apiKey }),
      },
      id: Bun.randomUUIDv7(),
      targetId: targetOf(event.input),
    });
  } catch (error) {
    logError(
      `the audit entry ${event.action} was not written: ${reasonOf(error)}`
    );
  }
}

/** A page of the log, newest first, with the accounts to filter by; nothing when the database cannot answer. */
export async function readAuditLog(
  storage: AuditStorage,
  filter: AuditFilter
): Promise<AuditView | undefined> {
  try {
    const [entries, actors] = await Promise.all([
      storage.audit.list({ ...filter, limit: auditPageSize + 1 }),
      storage.audit.actors(),
    ]);
    return {
      actors,
      entries: entries.slice(0, auditPageSize),
      more: entries.length > auditPageSize,
    };
  } catch {
    // A database that cannot answer shows no log, never a thrown error.
  }
}

const dayMs = 24 * 60 * 60 * 1000;

/** Deletes the entries older than the install's retention; answers how many went. */
export async function purgeAudit(
  storage: Pick<Storage, "audit" | "settings">,
  now: number
): Promise<number> {
  const days = await readRetentionDays(storage);
  return await storage.audit.purgeBefore(now - days * dayMs);
}
