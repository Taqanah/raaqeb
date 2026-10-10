/**
 * Boot settings (CONTEXT.md "Boot setting"): the values Raaqeb needs
 * before it can open the database, read from flags, the environment and, for
 * the two values onboarding writes there, `config.json` in the data directory.
 * `RAAQEB_TRUSTED_PROXIES` is read here too, though it is not a boot setting:
 * it overrides the trusted proxies setting.
 */

import { proxyEntries } from "@/shared/schemas/settings.ts";
import {
  type ConfigFile,
  ensureDataDir,
  readConfigFile,
  secretFilesIn,
  writeConfigFile,
} from "./datadir.ts";
import {
  decrypt,
  generateInstallKey,
  type InstallKey,
  importInstallKey,
} from "./installkey.ts";
import { isProxyEntry } from "./proxies.ts";

/** The seven variables, in the order the docs' boot settings page lists them (`website/content/docs/operate/boot-settings.en.mdx`). */
export const bootVariables = [
  "RAAQEB_PORT",
  "RAAQEB_HOST",
  "RAAQEB_DATA_DIR",
  "RAAQEB_TRUSTED_PROXIES",
  "RAAQEB_SECRET_KEY",
  "DATABASE_URL",
  "BETTER_AUTH_SECRETS",
] as const;
export type BootVariable = (typeof bootVariables)[number];

/** The raw values one source (flags or environment) gives, keyed by variable. */
export type BootValues = Partial<Record<BootVariable, string>>;

export interface BootSettings {
  /** Better Auth's versioned secret override, passed through untouched. */
  betterAuthSecrets: string | undefined;
  /** From `DATABASE_URL` or decrypted from `config.json`; absent until onboarding chooses one. */
  databaseUrl: string | undefined;
  /** The URL came from `DATABASE_URL`, not `config.json`: the database row in settings is managed by environment. */
  databaseUrlFromEnvironment: boolean;
  dataDir: string;
  host: string;
  installKey: InstallKey;
  port: number;
  /** `RAAQEB_TRUSTED_PROXIES`, empty when unset; when set it wins over the trusted proxies setting and locks its field. */
  trustedProxies: string[];
  /** Where the entries came from when there are any: `--trusted-proxies`, which wins, or the variable. */
  trustedProxiesFrom?: "flag" | "variable";
}

export type BootSettingsResult =
  | { ok: true; settings: BootSettings; notes: string[] }
  | { ok: false; message: string };

const defaults = { dataDir: "./data", host: "127.0.0.1", port: 3000 } as const;
/** Better Auth's versioned form: `<version>:<secret>` entries separated by commas, first entry current. */
export const versionedSecrets = /^\d+:[^,\s]+(,\d+:[^,\s]+)*$/;
/** The listen address alone, for `raaqeb health`, which must not create the data directory or an install key. */
export type AddressResult =
  | { ok: true; host: string; port: number }
  | { ok: false; message: string };

/** Resolves `RAAQEB_HOST` and `RAAQEB_PORT` from flags, then the environment, then the defaults. */
export function resolveAddress(
  flags: BootValues,
  env: Readonly<Record<string, string | undefined>>
): AddressResult {
  const given = givenBy(flags, env);
  const rawPort = given("RAAQEB_PORT");
  const port = rawPort === undefined ? defaults.port : Number(rawPort);
  if (rawPort !== undefined && (!portDigits.test(rawPort) || port > maxPort)) {
    return {
      message: `RAAQEB_PORT is not a port number (${rawPort.length} characters)`,
      ok: false,
    };
  }
  const rawHost = given("RAAQEB_HOST");
  const host = rawHost === undefined ? defaults.host : rawHost.trim();
  if (host === "") {
    return { message: "RAAQEB_HOST is blank", ok: false };
  }
  return { host, ok: true, port };
}

/** A variable's value from the flags, then the environment; an empty value counts as unset. */
function givenBy(
  flags: BootValues,
  env: Readonly<Record<string, string | undefined>>
): (variable: BootVariable) => string | undefined {
  return (variable) => {
    const value = flags[variable] ?? env[variable];
    return value === undefined || value === "" ? undefined : value;
  };
}

const portDigits = /^\d{1,5}$/;
const maxPort = 65_535;

function refuse(message: string): BootSettingsResult {
  return { message, ok: false };
}

/**
 * Resolves every boot setting: flag, then variable, then `config.json`, then
 * the default. Creates the data directory, and generates the install key into
 * `config.json` when no source has one. A failure message names the variable
 * and the length of its value, never the value. The notes are lines for the
 * operator's log.
 */
export async function resolveBootSettings(
  flags: BootValues,
  env: Readonly<Record<string, string | undefined>>
): Promise<BootSettingsResult> {
  const notes: string[] = [];
  const given = givenBy(flags, env);

  const address = resolveAddress(flags, env);
  if (!address.ok) {
    return refuse(address.message);
  }
  const { host, port } = address;

  const trustedProxies = proxyEntries(given("RAAQEB_TRUSTED_PROXIES") ?? "");
  const badProxy = trustedProxies.findIndex((entry) => !isProxyEntry(entry));
  if (badProxy !== -1) {
    return refuse(
      `RAAQEB_TRUSTED_PROXIES entry ${badProxy + 1} is not an IP address or a CIDR range (${trustedProxies[badProxy]?.length} characters)`
    );
  }

  const betterAuthSecrets = given("BETTER_AUTH_SECRETS");
  if (betterAuthSecrets !== undefined) {
    const versions = betterAuthSecrets
      .split(",")
      .map((entry) => entry.slice(0, entry.indexOf(":")));
    if (
      !versionedSecrets.test(betterAuthSecrets) ||
      new Set(versions).size !== versions.length
    ) {
      return refuse(
        `BETTER_AUTH_SECRETS is not in the versioned form <version>:<secret> with each version once (${betterAuthSecrets.length} characters)`
      );
    }
  }

  const dataDir = given("RAAQEB_DATA_DIR") ?? defaults.dataDir;
  let widerThanOwner: boolean;
  try {
    ({ widerThanOwner } = await ensureDataDir(dataDir));
  } catch {
    return refuse(
      `RAAQEB_DATA_DIR cannot be created (${dataDir.length} characters)`
    );
  }
  const file = await readConfigFile(dataDir);
  if (!file.ok) {
    return refuse(file.message);
  }
  const { config } = file;

  const key = await resolveInstallKey(
    given("RAAQEB_SECRET_KEY"),
    config,
    dataDir,
    notes
  );
  if (!key.ok) {
    return key;
  }
  const { installKey } = key;
  // Checked after the key step, which may have just written config.json; with neither file the mode guards nothing secret.
  if (widerThanOwner) {
    const held = await secretFilesIn(dataDir);
    if (held.length > 0) {
      notes.push(
        `the data directory's mode is wider than 0700; ${held.join(" and ")} ${held.length === 1 ? "holds" : "hold"} secrets`
      );
    }
  }

  const url = await resolveDatabaseUrl(
    given("DATABASE_URL"),
    config,
    installKey
  );
  if (!url.ok) {
    return url;
  }
  const { databaseUrl } = url;

  return {
    notes,
    ok: true,
    settings: {
      betterAuthSecrets,
      databaseUrl,
      databaseUrlFromEnvironment: given("DATABASE_URL") !== undefined,
      dataDir,
      host,
      installKey,
      port,
      trustedProxies,
      // givenBy reads the flag first, so a flag given at all is the source.
      ...(trustedProxies.length > 0 && {
        trustedProxiesFrom:
          flags.RAAQEB_TRUSTED_PROXIES === undefined ? "variable" : "flag",
      }),
    },
  };
}

type InstallKeyResult =
  | { ok: true; installKey: InstallKey }
  | { ok: false; message: string };

/** The variable, then `config.json`, then a new key written there. */
async function resolveInstallKey(
  raw: string | undefined,
  config: ConfigFile,
  dataDir: string,
  notes: string[]
): Promise<InstallKeyResult> {
  if (raw !== undefined) {
    const installKey = await importInstallKey(raw);
    if (!installKey) {
      return {
        message: `RAAQEB_SECRET_KEY is not a key: expected 32 bytes in base64url, got ${raw.length} characters`,
        ok: false,
      };
    }
    if (config.installKey !== undefined) {
      notes.push(
        "RAAQEB_SECRET_KEY is set; the key in config.json is not used"
      );
    }
    return { installKey, ok: true };
  }
  if (config.installKey !== undefined) {
    const installKey = await importInstallKey(config.installKey);
    return installKey
      ? { installKey, ok: true }
      : {
          message: "config.json holds a key that is not 32 bytes in base64url",
          ok: false,
        };
  }
  const encoded = generateInstallKey();
  try {
    await writeConfigFile(dataDir, { ...config, installKey: encoded });
  } catch {
    return {
      message: "config.json cannot be written in the data directory",
      ok: false,
    };
  }
  const installKey = await importInstallKey(encoded);
  if (!installKey) {
    return { message: "the generated install key does not import", ok: false };
  }
  notes.push("install key generated into config.json in the data directory");
  return { installKey, ok: true };
}

type DatabaseUrlResult =
  | { ok: true; databaseUrl: string | undefined }
  | { ok: false; message: string };

/** The variable, then `config.json` opened with the install key, then nothing. */
async function resolveDatabaseUrl(
  raw: string | undefined,
  config: ConfigFile,
  installKey: InstallKey
): Promise<DatabaseUrlResult> {
  if (raw !== undefined) {
    return { databaseUrl: raw, ok: true };
  }
  if (config.databaseUrl === undefined) {
    return { databaseUrl: undefined, ok: true };
  }
  const databaseUrl = await decrypt(installKey, config.databaseUrl);
  return databaseUrl === undefined
    ? {
        message: "config.json holds a DATABASE_URL the install key cannot open",
        ok: false,
      }
    : { databaseUrl, ok: true };
}
