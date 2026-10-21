/**
 * The operator accounts repository (CONTEXT.md "Operator account"): Better
 * Auth creates each account and owns its credentials; this reads them all,
 * with whether the second step and the authenticator app are on, and makes
 * the changes Better Auth has no call for: the role, deactivating, removing,
 * the name, the operator's preferences, ending sessions, and the reset
 * command's and the settings page's removal of the second step.
 */

import { type SQL, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import { type Role, roles } from "@/shared/domain/roles.ts";
import { localeSchema } from "@/shared/i18n/locale.ts";
import {
  calendarSchema,
  clockSchema,
  timeZoneSchema,
} from "@/shared/schemas/clock.ts";
import type { AccountSettingsInput } from "@/shared/schemas/settings.ts";
import type { AccountSession, OperatorAccount } from "@/shared/schemas/team.ts";
import type { Executor } from "./connection.ts";

export interface OperatorAccountsRepository {
  /** Removes the account's authenticator app and its backup codes and leaves the second step as it is. */
  appOff: (id: string) => Promise<void>;
  /** Sets the account deactivated at the time and ends every session of it, in one transaction; false when there is no such account. */
  deactivate: (id: string, at: number) => Promise<boolean>;
  /** Ends one session of the account; false when it has no such session. */
  endSession: (id: string, sessionId: string) => Promise<boolean>;
  /** Ends every session of the account. */
  endSessions: (id: string) => Promise<void>;
  /** True once onboarding created the first account. Throws when the database cannot answer. */
  exists: () => Promise<boolean>;
  find: (id: string) => Promise<OperatorAccount | undefined>;
  /** The account with the address, matched without regard to case. */
  findByEmail: (email: string) => Promise<OperatorAccount | undefined>;
  /** Every account, oldest first. */
  list: () => Promise<OperatorAccount[]>;
  /** Clears the deactivation; false when there is no such account. */
  reactivate: (id: string) => Promise<boolean>;
  /** Deletes the account, with its sessions, credentials, second step and settings of its own; false when there is none. */
  remove: (id: string) => Promise<boolean>;
  rename: (id: string, name: string) => Promise<boolean>;
  /** Switches the account's second step off and removes its authenticator app and backup codes. */
  secondStepOff: (id: string) => Promise<void>;
  /** The account's live sessions, newest first; `current` is the one whose id is given. */
  sessions: (
    id: string,
    now: number,
    currentSessionId?: string
  ) => Promise<AccountSession[]>;
  /** Replaces the account's preferences; an absent field follows the install. */
  setPreferences: (
    id: string,
    preferences: AccountSettingsInput
  ) => Promise<boolean>;
  setRole: (id: string, role: Role) => Promise<boolean>;
}

interface AccountRow {
  readonly app: number | boolean;
  readonly calendar: string | null;
  readonly clock: string | null;
  readonly created_at: number;
  readonly deactivated_at: number | null;
  readonly email: string;
  readonly id: string;
  readonly language: string | null;
  readonly last_sign_in_at: number | null;
  readonly name: string;
  readonly role: string;
  readonly time_zone: string | null;
  readonly two_factor_enabled: number | boolean;
}

/** A stored preference the install still knows, else nothing: it follows the install. */
function known<T>(schema: ZodType<T>, value: string | null): T | undefined {
  const parsed = schema.safeParse(value ?? undefined);
  return parsed.success ? parsed.data : undefined;
}

function accountOf(row: AccountRow): OperatorAccount {
  const values: AccountSettingsInput = {
    calendar: known(calendarSchema, row.calendar),
    clock: known(clockSchema, row.clock),
    operatorLanguage: known(localeSchema, row.language),
    timeZone: known(timeZoneSchema, row.time_zone),
  };
  // Only the preferences that are set, so an absent one reads as following the install.
  const preferences: AccountSettingsInput = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  );
  return {
    app: Number(row.app) === 1,
    createdAt: Number(row.created_at),
    deactivatedAt:
      row.deactivated_at === null ? null : Number(row.deactivated_at),
    email: row.email,
    id: row.id,
    lastSignInAt:
      row.last_sign_in_at === null ? null : Number(row.last_sign_in_at),
    name: row.name,
    preferences,
    // A role the code no longer names reads as the least one, never as more.
    role: (roles as readonly string[]).includes(row.role)
      ? (row.role as Role)
      : "viewer",
    secondStep: Number(row.two_factor_enabled) === 1,
  };
}

export function operatorAccountsRepository(
  executor: Executor
): OperatorAccountsRepository {
  const { authSession, authTwoFactor, authUser, settings } = executor.tables;
  const column = (name: string) => sql.identifier(name);
  const select = (where: SQL) =>
    executor.rows<AccountRow>(
      sql`SELECT ${authUser.id} AS id, ${authUser.email} AS email, ${authUser.name} AS name, ${authUser.role} AS role, ${authUser.twoFactorEnabled} AS two_factor_enabled, ${authUser.deactivatedAt} AS deactivated_at, ${authUser.lastSignInAt} AS last_sign_in_at, ${authUser.createdAt} AS created_at, ${authUser.language} AS language, ${authUser.timeZone} AS time_zone, ${authUser.clock} AS clock, ${authUser.calendar} AS calendar, EXISTS (SELECT 1 FROM ${authTwoFactor} WHERE ${authTwoFactor.userId} = ${authUser.id} AND ${authTwoFactor.verified} = 1) AS app FROM ${authUser} WHERE ${where} ORDER BY ${authUser.createdAt}, ${authUser.id}`
    );
  const update = async (id: string, set: SQL): Promise<boolean> =>
    (await executor.run(
      sql`UPDATE ${authUser} SET ${set} WHERE ${authUser.id} = ${id}`
    )) > 0;
  return {
    appOff: async (id) => {
      await executor.run(
        sql`DELETE FROM ${authTwoFactor} WHERE ${authTwoFactor.userId} = ${id}`
      );
    },
    deactivate: (id, at) =>
      executor.transaction(async (tx) => {
        const changed =
          (await tx.run(
            sql`UPDATE ${authUser} SET ${column(authUser.deactivatedAt.name)} = ${at} WHERE ${authUser.id} = ${id}`
          )) > 0;
        await tx.run(
          sql`DELETE FROM ${authSession} WHERE ${authSession.userId} = ${id}`
        );
        return changed;
      }),
    endSession: async (id, sessionId) =>
      (await executor.run(
        sql`DELETE FROM ${authSession} WHERE ${authSession.userId} = ${id} AND ${authSession.id} = ${sessionId}`
      )) > 0,
    endSessions: async (id) => {
      await executor.run(
        sql`DELETE FROM ${authSession} WHERE ${authSession.userId} = ${id}`
      );
    },
    exists: async () => {
      const rows = await executor.rows<{ one: number }>(
        sql`SELECT 1 AS one FROM ${authUser} LIMIT 1`
      );
      return rows.length > 0;
    },
    find: async (id) => {
      const [row] = await select(sql`${authUser.id} = ${id}`);
      return row && accountOf(row);
    },
    findByEmail: async (email) => {
      const [row] = await select(
        sql`lower(${authUser.email}) = ${email.toLowerCase()}`
      );
      return row && accountOf(row);
    },
    list: async () => (await select(sql`1 = 1`)).map(accountOf),
    reactivate: (id) =>
      update(id, sql`${column(authUser.deactivatedAt.name)} = NULL`),
    remove: (id) =>
      executor.transaction(async (tx) => {
        // The sessions, credentials and authenticator app go with the row (ON DELETE CASCADE).
        const removed =
          (await tx.run(
            sql`DELETE FROM ${authUser} WHERE ${authUser.id} = ${id}`
          )) > 0;
        await tx.run(
          sql`DELETE FROM ${settings} WHERE ${settings.key} LIKE ${`%:${id}`}`
        );
        return removed;
      }),
    rename: (id, name) =>
      update(id, sql`${column(authUser.name.name)} = ${name}`),
    secondStepOff: (id) =>
      executor.transaction(async (tx) => {
        await tx.run(
          sql`DELETE FROM ${authTwoFactor} WHERE ${authTwoFactor.userId} = ${id}`
        );
        await tx.run(
          sql`UPDATE ${authUser} SET ${column(authUser.twoFactorEnabled.name)} = 0 WHERE ${authUser.id} = ${id}`
        );
      }),
    sessions: async (id, now, currentSessionId) => {
      const rows = await executor.rows<{
        created_at: number;
        expires_at: number;
        id: string;
        ip_address: string | null;
        updated_at: number;
        user_agent: string | null;
      }>(
        sql`SELECT ${authSession.id} AS id, ${authSession.createdAt} AS created_at, ${authSession.updatedAt} AS updated_at, ${authSession.expiresAt} AS expires_at, ${authSession.ipAddress} AS ip_address, ${authSession.userAgent} AS user_agent FROM ${authSession} WHERE ${authSession.userId} = ${id} AND ${authSession.expiresAt} > ${now} ORDER BY ${authSession.createdAt} DESC`
      );
      return rows.map((row) => ({
        createdAt: Number(row.created_at),
        current: row.id === currentSessionId,
        expiresAt: Number(row.expires_at),
        id: row.id,
        ipAddress: row.ip_address,
        updatedAt: Number(row.updated_at),
        userAgent: row.user_agent,
      }));
    },
    setPreferences: (id, preferences) =>
      update(
        id,
        sql`${column(authUser.language.name)} = ${preferences.operatorLanguage ?? null}, ${column(authUser.timeZone.name)} = ${preferences.timeZone ?? null}, ${column(authUser.clock.name)} = ${preferences.clock ?? null}, ${column(authUser.calendar.name)} = ${preferences.calendar ?? null}`
      ),
    setRole: (id, role) =>
      update(id, sql`${column(authUser.role.name)} = ${role}`),
  };
}
