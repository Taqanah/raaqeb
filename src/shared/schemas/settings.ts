/**
 * The settings pages' inputs (CONTEXT.md "Setting"):
 * what the general and account pages post, and what the account page posts
 * to change the operator's email or password. Each refusal is a code the page
 * words through the catalog (ADR-0004).
 */
import { z } from "zod";
import { type Locale, localeSchema } from "@/shared/i18n/locale.ts";
import { publicAddressSchema } from "./address.ts";
import { codeSchema, passwordMaxLength, passwordMinLength } from "./auth.ts";
import {
  type Calendar,
  type Clock,
  calendarSchema,
  clockSchema,
  timeZoneSchema,
} from "./clock.ts";
import { retentionDaysMax, retentionDaysMin } from "./monitor.ts";
import type { SendFailure } from "./notification.ts";

/** What the general page shows: the fields, the host zone named beside the zone field, and the database row. */
export interface GeneralSettings {
  readonly calendar: Calendar;
  readonly clock: Clock;
  readonly database: {
    readonly backend: "sqlite" | "postgres";
    /** `DATABASE_URL` is set: the row renders locked with the managed-by-environment note. */
    readonly managedByEnvironment: boolean;
  };
  /** The host's zone, offered as the default and named beside the field. */
  readonly hostTimeZone: string;
  readonly installLanguage: Locale;
  /** The signed-in operator's own language, nothing while it follows the install's: a change of the install language previews only then. */
  readonly operatorLanguage: Locale | undefined;
  readonly publicAddress: string;
  readonly releaseCheck: boolean;
  readonly requestLog: boolean;
  readonly timeZone: string;
  /** The zones the server knows, so the document and the browser offer the same names. */
  readonly timeZones: readonly string[];
  readonly trustedProxies: {
    /** The addresses and ranges in force: the variable's when it is set, else the stored ones. */
    readonly entries: readonly string[];
    /** `RAAQEB_TRUSTED_PROXIES` is set: the field renders locked with the managed-by-environment note. */
    readonly managedByEnvironment: boolean;
  };
}

export const generalSettingsSchema = z.object({
  calendar: calendarSchema,
  clock: clockSchema,
  installLanguage: localeSchema,
  publicAddress: publicAddressSchema,
  releaseCheck: z.boolean(),
  requestLog: z.boolean(),
  timeZone: timeZoneSchema,
  /** Absent when the variable manages the field; each entry is judged on the server by the rule the variable's are. */
  trustedProxies: z.array(z.string()).optional(),
});
export type GeneralSettingsInput = z.infer<typeof generalSettingsSchema>;

/** The operator's own overrides; an absent field means "as the install". */
export const accountSettingsSchema = z.object({
  calendar: calendarSchema.optional(),
  clock: clockSchema.optional(),
  operatorLanguage: localeSchema.optional(),
  timeZone: timeZoneSchema.optional(),
});
export type AccountSettingsInput = z.infer<typeof accountSettingsSchema>;

/** What the account page shows: the overrides, and the install values the absent ones fall back to. */
export interface AccountSettings {
  readonly install: {
    readonly calendar: Calendar;
    readonly clock: Clock;
    readonly language: Locale;
    readonly timeZone: string;
  };
  readonly overrides: AccountSettingsInput;
  readonly timeZones: readonly string[];
}

/** A new address takes the current password, as a new password does: a session alone cannot move the account. */
export const emailChangeSchema = z.object({
  currentPassword: z.string().min(1),
  email: z.email(),
});
export type EmailChangeInput = z.infer<typeof emailChangeSchema>;

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(passwordMinLength).max(passwordMaxLength),
});
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

/** A megabyte as the storage page counts it, 2^20 bytes. */
export const megabyte = 1024 * 1024;

/** The smallest size budget: the SQLite reserve's size, so a budget never asks for less than the disk keeps free. */
export const sizeBudgetMinBytes = 64 * megabyte;

/** The largest size budget, one terabyte. */
export const sizeBudgetMaxBytes = 1024 * 1024 * megabyte;

/** The free disk a local SQLite file keeps, with or without a size budget. */
export const reserveBytes = 64 * megabyte;

/** What the storage page shows: the retention and the size budget, and the sizes behind them. */
export interface StorageSettings {
  readonly backend: "sqlite" | "postgres";
  /** The free disk under the SQLite file; none on Postgres or when it could not be read. */
  readonly freeBytes: number | undefined;
  readonly retentionDays: number;
  /** None means unlimited. */
  readonly sizeBudgetBytes: number | undefined;
  /** Raaqeb's used size, as the size budget reads it; none when it could not be read. */
  readonly usedBytes: number | undefined;
}

export const storageSettingsSchema = z.object({
  retentionDays: z.int().min(retentionDaysMin).max(retentionDaysMax),
  /** Absent means unlimited. */
  sizeBudgetBytes: z
    .int()
    .min(sizeBudgetMinBytes)
    .max(sizeBudgetMaxBytes)
    .optional(),
});
export type StorageSettingsInput = z.infer<typeof storageSettingsSchema>;

/** Why a settings page did not save. */
export type SaveRefusal =
  /** The input did not parse. */
  | "invalid"
  /** No database is open, or it did not answer. */
  | "unavailable";

export type SaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SaveRefusal };

/** Why the general page did not save: a settings page's refusals, a public address whose host a status page serves as its custom domain, or a trusted proxy that is not an IP address or a CIDR range. */
export type GeneralSaveRefusal =
  | SaveRefusal
  | "address_is_page_domain"
  | "trusted_proxy_invalid";

/** The entries of a trusted proxies list as the variable and the field write it: separated by commas, trimmed, blanks dropped. */
export function proxyEntries(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export type GeneralSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: GeneralSaveRefusal };

/** Why the operator's email did not change. */
export type EmailChangeRefusal =
  | "invalid"
  /** The new address is the current one. */
  | "same_email"
  /** Not signed in, or Better Auth did not answer. */
  | "unavailable"
  /** The current password did not verify. */
  | "wrong_password";

/** The auth settings screen's choice of the email channel auth mail goes through. */
export const authEmailChannelSchema = z.object({
  channelId: z.string().min(1),
});
export type AuthEmailChannelInput = z.infer<typeof authEmailChannelSchema>;

/** Why the test message did not go. */
export type AuthTestRefusal =
  /** No email channel exists. */
  | "no_channel"
  /** The channel's send failed; the failure says what it saw. */
  | "failed"
  | "unavailable";

export type AuthTestResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AuthTestRefusal;
      readonly failure?: SendFailure;
    };

/** The second step's switch: on or off, with the current password Better Auth requires. */
export const secondStepSchema = z.object({
  on: z.boolean(),
  password: z.string().min(1),
});
export type SecondStepInput = z.infer<typeof secondStepSchema>;

/** Why the second step did not switch. */
export type SecondStepRefusal =
  | "invalid"
  /** On was asked before a test message went through the channel in force. */
  | "not_tested"
  | "wrong_password"
  | "unavailable";

/** What the sign-in settings page shows. */
export interface SecondStepView {
  /** An authenticator app is set up: its first code was entered. */
  readonly app: boolean;
  /** The channel auth mail goes through: the chosen one, else the oldest; nothing without an email channel. */
  readonly channel: string | undefined;
  /** Every email channel, oldest first. */
  readonly channels: readonly { readonly id: string; readonly name: string }[];
  /** The operator account's address, where auth mail goes. */
  readonly email: string;
  readonly on: boolean;
  /** A test message went through the channel in force. */
  readonly tested: boolean;
}

export type SecondStepResult =
  | { readonly ok: true; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: SecondStepRefusal };

/** Setting up the authenticator app, or a new set of backup codes: the current password Better Auth requires. */
export const appPasswordSchema = z.object({ password: z.string().min(1) });
export type AppPasswordInput = z.infer<typeof appPasswordSchema>;

/** Why the authenticator app's setup or a new set of backup codes was refused. */
export type AppPasswordRefusal = "invalid" | "wrong_password" | "unavailable";

/** The authenticator app's setup, before its first code: the secret as the QR code carries it and as text, and the ten backup codes, shown once. */
export type AppSetupResult =
  | {
      readonly ok: true;
      readonly backupCodes: readonly string[];
      /** The secret in base32, as an authenticator app takes it typed. */
      readonly secret: string;
      /** The otpauth URI the QR code carries. */
      readonly uri: string;
    }
  | { readonly ok: false; readonly reason: AppPasswordRefusal };

/** The authenticator app's first code, which puts it in force. */
export const appConfirmSchema = codeSchema.pick({ code: true });
export type AppConfirmInput = z.input<typeof appConfirmSchema>;

/** Why the first code did not put the app in force. */
export type AppConfirmRefusal = "invalid" | "wrong_code" | "unavailable";

export type AppConfirmResult =
  | { readonly ok: true; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: AppConfirmRefusal };

/** A new set of backup codes, shown once; the old set stops working. */
export type BackupCodesResult =
  | { readonly ok: true; readonly backupCodes: readonly string[] }
  | { readonly ok: false; readonly reason: AppPasswordRefusal };

/** Why the operator's password did not change. */
export type PasswordChangeRefusal =
  | "invalid"
  /** The current password did not verify. */
  | "wrong_password"
  | "unavailable";

/** The general and account pages' search: a language picked and not yet saved, which the root renders the page in; anything else is none. */
export const settingsSearchSchema = z.object({
  locale: localeSchema.optional().catch(undefined),
});
