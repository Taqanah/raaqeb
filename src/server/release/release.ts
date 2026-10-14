/**
 * The release check: once a day the server asks the GitHub
 * Releases API for the latest release, keeps the answer as a setting, and the
 * admin shell shows a banner linking to the release notes when it is newer
 * than the running build. Never auto-updates. Switched off in settings only.
 * The check runs when an admin request finds the stored answer older than a
 * day, in the background; the scheduler leaves it there.
 */
import { z } from "zod";
import { error as logError } from "@/server/log.ts";
import { defineSetting, type Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { type Release, releaseSchema } from "@/shared/schemas/release.ts";
import { newerVersion } from "./version.ts";

/** The public repository the check reads, as `owner/name`. */
export const repository = "Taqanah/raaqeb";

// The package's version, which vite.config.ts defines into the build; a run from the source tree has none.
declare const __RAAQEB_VERSION__: string | undefined;

/**
 * The running build's version: `version` in package.json, stamped by the
 * build. A run from the source tree, as in tests, has no
 * build and reads 0.0.0, so every published release counts as newer there.
 */
export const currentVersion: string =
  typeof __RAAQEB_VERSION__ === "string" ? __RAAQEB_VERSION__ : "0.0.0";

const day = 86_400_000;
const leadingV = /^v/;

const resultSchema = z.object({
  checkedAt: z.number(),
  latest: releaseSchema.optional(),
});

/** The switch (default on) and the stored answer of the last check. */
export const releaseCheckEnabled: Setting<boolean> = defineSetting(
  "release_check_enabled",
  z.boolean()
);
export const releaseCheckResult: Setting<ReleaseCheckResult> = defineSetting(
  "release_check_result",
  resultSchema
);

/** The last check: when it ran, and the latest release if the API answered. */
export interface ReleaseCheckResult {
  readonly checkedAt: number;
  readonly latest?: Release;
}

/** The part of `fetch` the check uses. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RefreshOptions {
  /** The fetch to use; tests pass a fake, the shell the platform's. */
  readonly fetch: Fetch;
  readonly now: () => number;
  /** The repository to ask, `repository` by default. */
  readonly repository?: string;
  /** How long one request may take, 10 seconds by default. */
  readonly timeoutMs?: number;
  /** The running build's version, `currentVersion` by default. */
  readonly version?: string;
}

// What the API answers for /releases/latest; the rest of the body is ignored.
const apiReleaseSchema = z.object({
  html_url: releaseSchema.shape.url,
  tag_name: z.string(),
});

// One check in flight per storage, so admin requests landing together share it.
const inFlight = new WeakMap<Pick<Storage, "settings">, Promise<void>>();

/**
 * Runs the check when the switch is on and the stored
 * answer is older than a day, at most once at a time per storage, and stores
 * what it found. A failed
 * request stores the time only, so the next attempt waits a day too. Never
 * throws.
 */
export function refreshRelease(
  storage: Pick<Storage, "settings">,
  options: RefreshOptions
): Promise<void> {
  const running = inFlight.get(storage);
  if (running !== undefined) {
    return running;
  }
  const run = refresh(storage, options)
    .catch(() => undefined)
    .finally(() => inFlight.delete(storage));
  inFlight.set(storage, run);
  return run;
}

async function refresh(
  storage: Pick<Storage, "settings">,
  options: RefreshOptions
): Promise<void> {
  const named = options.repository ?? repository;
  const enabled = await readEnabled(storage);
  if (!enabled) {
    return;
  }
  const stored = await readStoredResult(storage);
  const now = options.now();
  if (stored && now - stored.checkedAt < day) {
    return;
  }
  const latest = await fetchLatest(named, options);
  await storage.settings.set(
    releaseCheckResult,
    latest ? { checkedAt: now, latest } : { checkedAt: now }
  );
}

async function fetchLatest(
  named: string,
  options: RefreshOptions
): Promise<Release | undefined> {
  const version = options.version ?? currentVersion;
  try {
    const response = await options.fetch(
      `https://api.github.com/repos/${named}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `raaqeb/${version}`,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      }
    );
    if (!response.ok) {
      return;
    }
    const parsed = apiReleaseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return;
    }
    return {
      url: parsed.data.html_url,
      version: parsed.data.tag_name.replace(leadingV, ""),
    };
  } catch {
    logError("the release check could not reach the GitHub Releases API");
  }
}

async function readEnabled(
  storage: Pick<Storage, "settings">
): Promise<boolean> {
  try {
    return (await storage.settings.get(releaseCheckEnabled)) ?? true;
  } catch {
    return true;
  }
}

/** The stored answer, or nothing when none is stored or it no longer fits. */
async function readStoredResult(
  storage: Pick<Storage, "settings">
): Promise<ReleaseCheckResult | undefined> {
  try {
    return await storage.settings.get(releaseCheckResult);
  } catch {
    return undefined;
  }
}

/** The stored latest release when it is newer than the running build, otherwise nothing. */
export function newerRelease(
  result: ReleaseCheckResult | undefined,
  version: string
): Release | undefined {
  const latest = result?.latest;
  if (!latest) {
    return;
  }
  return newerVersion(latest.version, version) ? latest : undefined;
}

/** What the banner shows: the newer release, or nothing while the check is off, has not run or found nothing newer. */
export async function readNewerRelease(
  storage: Pick<Storage, "settings">,
  version: string = currentVersion
): Promise<Release | undefined> {
  if (!(await readEnabled(storage))) {
    return;
  }
  return newerRelease(await readStoredResult(storage), version);
}
