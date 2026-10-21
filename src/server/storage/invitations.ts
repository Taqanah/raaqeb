/**
 * The invitations repository (CONTEXT.md "Invitation"): one row per
 * address, the link's token kept as its SHA-256 only, so neither a backup
 * nor a leaked database opens an invitation. Taking one deletes it, so a
 * link signs up once.
 */

import { type SQL, sql } from "drizzle-orm";
import { type Role, roles } from "@/shared/domain/roles.ts";
import type { Invitation } from "@/shared/schemas/team.ts";
import type { Executor } from "./connection.ts";

/** An invitation as it is written, with the hash of its link's token. */
export interface InvitationRow extends Invitation {
  readonly tokenHash: string;
}

export interface InvitationsRepository {
  find: (id: string) => Promise<Invitation | undefined>;
  /** Deletes the invitation of the address, if any; an account made another way for it closes it. */
  forget: (email: string) => Promise<void>;
  /** Every invitation, the newest first, expired ones included. */
  list: () => Promise<Invitation[]>;
  /** The invitation whose token has the hash, while it has not expired. */
  open: (tokenHash: string, now: number) => Promise<Invitation | undefined>;
  /** The address's invitation, matched without regard to case, while it has not expired. */
  openFor: (email: string, now: number) => Promise<Invitation | undefined>;
  /** Writes the invitation, replacing one to the same address. */
  put: (invitation: InvitationRow) => Promise<void>;
  /** A new token and lifetime for the invitation, so its old link stops working; false when it is gone. */
  renew: (
    id: string,
    tokenHash: string,
    createdAt: number,
    expiresAt: number
  ) => Promise<boolean>;
  /** Deletes the invitation; false when it was gone already. */
  revoke: (id: string) => Promise<boolean>;
  /** Deletes the open invitation whose token has the hash and answers it; nothing when it is not open, or another call took it first. */
  take: (tokenHash: string, now: number) => Promise<Invitation | undefined>;
}

interface Row {
  readonly created_at: number;
  readonly email: string;
  readonly expires_at: number;
  readonly id: string;
  readonly invited_by: string | null;
  readonly role: string;
}

function invitationOf(row: Row): Invitation {
  return {
    createdAt: Number(row.created_at),
    email: row.email,
    expiresAt: Number(row.expires_at),
    id: row.id,
    invitedBy: row.invited_by,
    // A role the code no longer names offers the least one, never more.
    role: (roles as readonly string[]).includes(row.role)
      ? (row.role as Role)
      : "viewer",
  };
}

export function invitationsRepository(
  executor: Executor
): InvitationsRepository {
  const { invitations } = executor.tables;
  const select = async (where: SQL, run: Executor = executor) =>
    (
      await run.rows<Row>(
        sql`SELECT ${invitations.id} AS id, ${invitations.email} AS email, ${invitations.role} AS role, ${invitations.invitedBy} AS invited_by, ${invitations.createdAt} AS created_at, ${invitations.expiresAt} AS expires_at FROM ${invitations} WHERE ${where} ORDER BY ${invitations.createdAt} DESC, ${invitations.id} DESC`
      )
    ).map(invitationOf);
  const name = (column: { name: string }) => sql.identifier(column.name);
  return {
    find: async (id) => (await select(sql`${invitations.id} = ${id}`))[0],
    forget: async (email) => {
      await executor.run(
        sql`DELETE FROM ${invitations} WHERE lower(${invitations.email}) = ${email.toLowerCase()}`
      );
    },
    list: () => select(sql`1 = 1`),
    open: async (tokenHash, now) =>
      (
        await select(
          sql`${invitations.tokenHash} = ${tokenHash} AND ${invitations.expiresAt} > ${now}`
        )
      )[0],
    openFor: async (email, now) =>
      (
        await select(
          sql`lower(${invitations.email}) = ${email.toLowerCase()} AND ${invitations.expiresAt} > ${now}`
        )
      )[0],
    put: (invitation) =>
      executor.transaction(async (tx) => {
        const email = invitation.email.toLowerCase();
        await tx.run(
          sql`DELETE FROM ${invitations} WHERE lower(${invitations.email}) = ${email}`
        );
        await tx.run(
          sql`INSERT INTO ${invitations} (${name(invitations.id)}, ${name(invitations.email)}, ${name(invitations.role)}, ${name(invitations.tokenHash)}, ${name(invitations.invitedBy)}, ${name(invitations.createdAt)}, ${name(invitations.expiresAt)}) VALUES (${invitation.id}, ${email}, ${invitation.role}, ${invitation.tokenHash}, ${invitation.invitedBy}, ${invitation.createdAt}, ${invitation.expiresAt})`
        );
      }),
    renew: async (id, tokenHash, createdAt, expiresAt) =>
      (await executor.run(
        sql`UPDATE ${invitations} SET ${name(invitations.tokenHash)} = ${tokenHash}, ${name(invitations.createdAt)} = ${createdAt}, ${name(invitations.expiresAt)} = ${expiresAt} WHERE ${invitations.id} = ${id}`
      )) > 0,
    revoke: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${invitations} WHERE ${invitations.id} = ${id}`
      )) > 0,
    take: (tokenHash, now) =>
      executor.transaction(async (tx) => {
        const [found] = await select(
          sql`${invitations.tokenHash} = ${tokenHash} AND ${invitations.expiresAt} > ${now}`,
          tx
        );
        if (!found) {
          return;
        }
        // The delete decides between two takes at once: only the one that removed the row answers it.
        const deleted = await tx.run(
          sql`DELETE FROM ${invitations} WHERE ${invitations.id} = ${found.id}`
        );
        return deleted > 0 ? found : undefined;
      }),
  };
}
