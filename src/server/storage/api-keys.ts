/**
 * The API keys repository (CONTEXT.md "API key"): each key kept with its
 * secret's SHA-256 only, so neither a backup nor a leaked database calls the
 * management API. A key goes with its account (ON DELETE CASCADE); the
 * accounts repository also deletes an account's keys when it is
 * deactivated and lowers them with its role.
 */

import { type SQL, sql } from "drizzle-orm";
import { type Role, roles } from "@/shared/domain/roles.ts";
import type { ApiKey } from "@/shared/schemas/api-key.ts";
import type { Executor } from "./connection.ts";

/** A key as it is written: its account, its secret's hash, its lifetime. */
export interface ApiKeyRow {
  readonly accountId: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly tokenHash: string;
}

export interface ApiKeysRepository {
  create: (row: ApiKeyRow) => Promise<void>;
  find: (id: string) => Promise<ApiKey | undefined>;
  /** Every key, expired ones included, the newest first. */
  list: () => Promise<ApiKey[]>;
  /** The account's keys, expired ones included, the newest first. */
  ofAccount: (accountId: string) => Promise<ApiKey[]>;
  /** The key whose secret has the hash, while it has not expired and its account is not deactivated. */
  open: (tokenHash: string, now: number) => Promise<ApiKey | undefined>;
  /** Deletes the key; false when it was gone already. */
  revoke: (id: string) => Promise<boolean>;
  /** Records a call: when, and from which client address. */
  used: (id: string, at: number, address: string | null) => Promise<void>;
}

interface Row {
  readonly account_email: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly account_role: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly id: string;
  readonly last_used_address: string | null;
  readonly last_used_at: number | null;
  readonly name: string;
  readonly role: string;
}

/** A stored role the code no longer names reads as the least one, never as more. */
function roleOf(stored: string): Role {
  return roles.find((role) => role === stored) ?? "viewer";
}

const numberOrNull = (value: number | null) =>
  value === null ? null : Number(value);

function keyOf(row: Row): ApiKey {
  return {
    account: {
      email: row.account_email,
      id: row.account_id,
      name: row.account_name,
      role: roleOf(row.account_role),
    },
    createdAt: Number(row.created_at),
    expiresAt: numberOrNull(row.expires_at),
    id: row.id,
    lastUsedAddress: row.last_used_address,
    lastUsedAt: numberOrNull(row.last_used_at),
    name: row.name,
    role: roleOf(row.role),
  };
}

export function apiKeysRepository(executor: Executor): ApiKeysRepository {
  const { apiKeys, authUser } = executor.tables;
  const name = (column: { name: string }) => sql.identifier(column.name);
  const select = async (where: SQL) =>
    (
      await executor.rows<Row>(
        sql`SELECT ${apiKeys.id} AS id, ${apiKeys.name} AS name, ${apiKeys.role} AS role, ${apiKeys.createdAt} AS created_at, ${apiKeys.expiresAt} AS expires_at, ${apiKeys.lastUsedAt} AS last_used_at, ${apiKeys.lastUsedAddress} AS last_used_address, ${authUser.id} AS account_id, ${authUser.email} AS account_email, ${authUser.name} AS account_name, ${authUser.role} AS account_role FROM ${apiKeys} JOIN ${authUser} ON ${authUser.id} = ${apiKeys.accountId} WHERE ${where} ORDER BY ${apiKeys.createdAt} DESC, ${apiKeys.id} DESC`
      )
    ).map(keyOf);
  return {
    create: async (row) => {
      await executor.run(
        sql`INSERT INTO ${apiKeys} (${name(apiKeys.id)}, ${name(apiKeys.accountId)}, ${name(apiKeys.name)}, ${name(apiKeys.role)}, ${name(apiKeys.tokenHash)}, ${name(apiKeys.createdAt)}, ${name(apiKeys.expiresAt)}) VALUES (${row.id}, ${row.accountId}, ${row.name}, ${row.role}, ${row.tokenHash}, ${row.createdAt}, ${row.expiresAt})`
      );
    },
    find: async (id) => (await select(sql`${apiKeys.id} = ${id}`))[0],
    list: () => select(sql`1 = 1`),
    ofAccount: (accountId) => select(sql`${apiKeys.accountId} = ${accountId}`),
    open: async (tokenHash, now) =>
      (
        await select(
          sql`${apiKeys.tokenHash} = ${tokenHash} AND (${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > ${now}) AND ${authUser.deactivatedAt} IS NULL`
        )
      )[0],
    revoke: async (id) =>
      (await executor.run(
        sql`DELETE FROM ${apiKeys} WHERE ${apiKeys.id} = ${id}`
      )) > 0,
    used: async (id, at, address) => {
      await executor.run(
        sql`UPDATE ${apiKeys} SET ${name(apiKeys.lastUsedAt)} = ${at}, ${name(apiKeys.lastUsedAddress)} = ${address} WHERE ${apiKeys.id} = ${id}`
      );
    },
  };
}
