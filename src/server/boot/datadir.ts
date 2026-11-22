/**
 * The data directory (CONTEXT.md): the one folder Raaqeb owns on disk, mode
 * 0700, and `config.json` inside it, mode 0600, holding only the generated
 * install key and the database URL onboarding chose.
 */
// biome-ignore lint/style/noRestrictedImports: Bun has no mkdir or realpath, and Bun.write cannot set a file mode
import { chmod, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { sqliteFileName } from "@/server/storage/sqlite.ts";

/** What `config.json` holds. The database URL is stored encrypted with the install key. */
export interface ConfigFile {
  databaseUrl?: string;
  installKey?: string;
}

export type ConfigFileResult =
  | { ok: true; config: ConfigFile }
  | { ok: false; message: string };

const fileName = "config.json";
const configKeys = ["installKey", "databaseUrl"] as const;

function refuse(message: string): ConfigFileResult {
  return { message, ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Creates the directory with mode 0700 when missing, tightens an existing one
 * that lets group or others in (a platform that mounts its own volume, such as
 * Fly, sets 0755 on every boot), and answers whether it is still wider, which
 * happens when it is not ours to change. On Windows a mode is only what Bun
 * makes up from the read-only flag, so it is never wider.
 */
export async function ensureDataDir(
  dataDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<{ widerThanOwner: boolean }> {
  await mkdir(dataDir, { mode: 0o700, recursive: true });
  if (platform === "win32") {
    return { widerThanOwner: false };
  }
  // The low two octal digits are the group and other bits.
  const wider = async () => (await Bun.file(dataDir).stat()).mode % 0o100 !== 0;
  if (await wider()) {
    await chmod(dataDir, 0o700).catch(() => undefined);
  }
  return { widerThanOwner: await wider() };
}

/** The data directory as it stands: its real absolute path, its permission bits, and which of `config.json` and the SQLite file, the two that hold secrets, are in it. */
export async function inspectDataDir(
  dataDir: string
): Promise<{ mode: number; path: string; secrets: string[] }> {
  const path = await realpath(dataDir);
  const { mode } = await Bun.file(path).stat();
  return { mode: mode % 0o1000, path, secrets: await secretFilesIn(path) };
}

/** The files in the data directory that hold secrets: config.json (the key, the URL) and the SQLite database (the password hash, sessions, sealed channel secrets). */
export async function secretFilesIn(dataDir: string): Promise<string[]> {
  const names = [fileName, sqliteFileName];
  const present = await Promise.all(
    names.map((name) => Bun.file(`${dataDir}/${name}`).exists())
  );
  return names.filter((_, index) => present[index]);
}

/** Reads `config.json`; a missing file is an empty config, an unreadable one is a failure. */
export async function readConfigFile(
  dataDir: string
): Promise<ConfigFileResult> {
  const file = Bun.file(`${dataDir}/${fileName}`);
  if (!(await file.exists())) {
    return { config: {}, ok: true };
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return refuse(`${fileName} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    return refuse(`${fileName} is not a JSON object`);
  }
  const config: ConfigFile = {};
  for (const key of configKeys) {
    const value = parsed[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return refuse(`${fileName} holds a ${key} that is not a string`);
    }
    config[key] = value;
  }
  return { config, ok: true };
}

/** Writes `config.json` whole, atomically, with mode 0600. */
export async function writeConfigFile(
  dataDir: string,
  config: ConfigFile
): Promise<void> {
  const path = `${dataDir}/${fileName}`;
  const draft = `${path}.tmp`;
  await writeFile(draft, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  // The mode above applies only to a new file; a leftover draft keeps its own.
  await chmod(draft, 0o600);
  await rename(draft, path);
}
