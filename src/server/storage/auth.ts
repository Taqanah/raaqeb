/**
 * Better Auth's view of the open database: its Drizzle adapter over
 * the connection, with the five auth tables mapped under the names Better
 * Auth expects (the two-factor plugin's is). Only this folder sees Drizzle, so the adapter is built here
 * and handed out on the storage; server/auth never touches a driver.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Connection } from "./connection.ts";
import { tables } from "./connection.ts";

/** The adapter factory Better Auth takes as its `database` option. */
export type AuthDatabase = ReturnType<typeof drizzleAdapter>;

/** The adapter for the connection's dialect, with the auth tables mapped. */
export function authDatabase(connection: Connection): AuthDatabase {
  const {
    authAccount,
    authSession,
    authTwoFactor,
    authUser,
    authVerification,
  } = tables[connection.backend];
  // Better Auth looks its models up by name in the schema object; the table
  // names themselves are the prefixed ones.
  const schema = {
    account: authAccount,
    session: authSession,
    twoFactor: authTwoFactor,
    user: authUser,
    verification: authVerification,
  };
  return connection.backend === "sqlite"
    ? drizzleAdapter(connection.db, { provider: "sqlite", schema })
    : drizzleAdapter(connection.db, { provider: "pg", schema });
}
