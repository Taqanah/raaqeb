/**
 * The operator account repository (CONTEXT.md "Operator account"): v1 has
 * exactly one, created by onboarding through Better Auth, which owns the
 * rows, its authenticator app's among them. Onboarding asks only whether it
 * exists; the auth settings screen and the reset command read it. The
 * command switches the second step off with no session, and the
 * settings page removes the app alone, which Better Auth cannot.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "./connection.ts";

export interface OperatorAccount {
  /** An authenticator app is set up: its first code was entered. */
  readonly app: boolean;
  readonly email: string;
  readonly id: string;
  /** The second step is on for this account. */
  readonly secondStep: boolean;
}

export interface OperatorAccountRepository {
  /** Removes the authenticator app and its backup codes and leaves the second step as it is; the settings page calls it once Better Auth verified the password. */
  appOff: () => Promise<void>;
  /** True once onboarding created the account. Throws when the database cannot answer. */
  exists: () => Promise<boolean>;
  /** The one account, or nothing before onboarding created it. */
  read: () => Promise<OperatorAccount | undefined>;
  /** Switches the second step off and removes the authenticator app and its backup codes, for the reset command; nothing to do without an account. */
  secondStepOff: () => Promise<void>;
}

export function operatorAccountRepository(
  executor: Executor
): OperatorAccountRepository {
  const { authTwoFactor, authUser } = executor.tables;
  return {
    appOff: async () => {
      await executor.run(sql`DELETE FROM ${authTwoFactor}`);
    },
    exists: async () => {
      const rows = await executor.rows<{ one: number }>(
        sql`SELECT 1 AS one FROM ${authUser} LIMIT 1`
      );
      return rows.length > 0;
    },
    read: async () => {
      // An app whose first code was never entered is not set up; Better Auth keeps its row unverified.
      const [row] = await executor.rows<{
        app: number | boolean;
        email: string;
        id: string;
        two_factor_enabled: number | boolean;
      }>(
        sql`SELECT ${authUser.id} AS id, ${authUser.email} AS email, ${authUser.twoFactorEnabled} AS two_factor_enabled, EXISTS (SELECT 1 FROM ${authTwoFactor} WHERE ${authTwoFactor.userId} = ${authUser.id} AND ${authTwoFactor.verified} = 1) AS app FROM ${authUser} ORDER BY ${authUser.createdAt} LIMIT 1`
      );
      return (
        row && {
          app: Number(row.app) === 1,
          email: row.email,
          id: row.id,
          secondStep: Number(row.two_factor_enabled) === 1,
        }
      );
    },
    secondStepOff: () =>
      executor.transaction(async (tx) => {
        await tx.run(sql`DELETE FROM ${authTwoFactor}`);
        await tx.run(
          sql`UPDATE ${authUser} SET ${sql.identifier(authUser.twoFactorEnabled.name)} = 0`
        );
      }),
  };
}
