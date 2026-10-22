/**
 * The audit log's shapes (CONTEXT.md "Audit entry"): one entry per change
 * an operator made or sign-in event, what the log page reads, and its
 * filters.
 */
import { z } from "zod";

/** A small, secret-free account of what was asked: scalar fields by name. */
export type AuditDetail = Readonly<Record<string, string | number | boolean>>;

export interface AuditEntry {
  readonly action: string;
  readonly actorEmail: string | null;
  readonly actorId: string | null;
  /** The client address behind the trusted proxies; none when the entry could not tell. */
  readonly address: string | null;
  readonly at: number;
  readonly detail: AuditDetail;
  readonly id: string;
  /** The record acted on: its id, or several joined by commas; none for an install-wide change. */
  readonly targetId: string | null;
}

/** The log page's filters: an action's kind, an account, refused attempts alone, the first and last day in the operator's zone (both inclusive), and the time the page reads back from. */
export const auditFilterSchema = z.object({
  actorId: z.string().max(100).optional(),
  before: z.number().int().positive().optional(),
  from: z.iso.date().optional(),
  kind: z.string().max(40).optional(),
  refused: z.boolean().optional(),
  to: z.iso.date().optional(),
});
export type AuditFilter = z.infer<typeof auditFilterSchema>;

/** What the log page shows: a page of entries, newest first, whether older ones remain, and every account an entry names, to filter by. */
export interface AuditView {
  readonly actors: readonly { readonly email: string; readonly id: string }[];
  readonly entries: readonly AuditEntry[];
  readonly more: boolean;
}

/** Entries a page reads. */
export const auditPageSize = 50;

/** How the export carries an entry; `detail` stays the small object it was written as. */
export const auditEntryExportSchema = z.object({
  action: z.string().max(80),
  address: z.string().max(100).nullable(),
  actorEmail: z.string().max(254).nullable(),
  actorId: z.string().max(100).nullable(),
  at: z.number().int(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  id: z.string().max(100),
  targetId: z.string().max(2000).nullable(),
});
