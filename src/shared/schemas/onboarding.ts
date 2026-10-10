/**
 * The onboarding screens' shapes (CONTEXT.md "Onboarding"): the
 * database choice and the operator account with its public address and the
 * install language. Each failure is a code the screen words through the
 * catalog, never a driver's or Better Auth's English text (ADR-0004).
 */
import { z } from "zod";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { publicAddressSchema } from "./address.ts";
import { passwordMaxLength, passwordMinLength } from "./auth.ts";

/** A Postgres URL as text; whether it connects is the connection test's answer, not the schema's. */
const postgresUrlSchema = z
  .string()
  .trim()
  .regex(/^postgres(ql)?:\/\//, "a postgres:// URL");

export const databaseChoiceSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("sqlite") }),
  z.object({ backend: z.literal("postgres"), url: postgresUrlSchema }),
]);

export type DatabaseChoice = z.infer<typeof databaseChoiceSchema>;

export const operatorAccountSchema = z.object({
  /** The operator confirmed the public address after the screen said the browser is not at it. */
  addressConfirmed: z.boolean().optional(),
  email: z.email(),
  locale: localeSchema,
  password: z.string().min(passwordMinLength).max(passwordMaxLength),
  publicAddress: publicAddressSchema,
});

export type OperatorAccountInput = z.infer<typeof operatorAccountSchema>;

/** Why the database screen did not move on. */
export type DatabaseRefusal =
  /** The connection test refused the database; the verdict on the screen says why. */
  | "refused"
  /** The database opened but a migration failed, or the data directory would not take `config.json`. */
  | "open_failed"
  /** A database is already open: the screen is behind the install. */
  | "already_chosen"
  /** The URL is not a Postgres URL. */
  | "invalid";

/** Why the account screen did not create the account. */
export type AccountRefusal =
  /** An operator account already exists: onboarding is over. */
  | "already_exists"
  /** No database is open yet: the database screen comes first. */
  | "no_database"
  /** The input did not parse. */
  | "invalid"
  /** The public address is not the origin the browser sent the form from, and the operator has not confirmed it: sign-in works only at the public address. */
  | "address_elsewhere"
  /** Better Auth refused the sign-up or the database did not answer. */
  | "unavailable";
