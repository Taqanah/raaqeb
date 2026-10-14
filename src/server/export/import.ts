/**
 * Import (CONTEXT.md "Import"): an export
 * read as a stream into an install that holds no monitors, status pages or
 * components. The header's configuration is written in one transaction
 * with every credential sealed again with this install's key; the history
 * follows a batch at a time, each monitor's closed days sealed once its
 * records end, and a day that came as hourly rollups gets its daily one
 * summed from them. The settings are written last, then the change counter
 * moves once. Anything that fails takes out what the import wrote, so the
 * install is as empty as before and the answer names the line. One import
 * runs at a time.
 */
import { encrypt, type InstallKey } from "@/server/boot/installkey.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import {
  mergeValues,
  splitValues,
  valuesSchema,
} from "@/server/notify/secrets.ts";
import { imageTypeOf } from "@/server/pages/images.ts";
import { releaseCheckEnabled } from "@/server/release/release.ts";
import { sealClosedDays } from "@/server/scheduler/sealing.ts";
import {
  appearanceDensity,
  appearanceFontSize,
  appearanceRadius,
  appearanceTheme,
} from "@/server/settings/appearance.ts";
import {
  calendar,
  clock,
  readClock,
  timeZone,
} from "@/server/settings/clock.ts";
import { installLanguage } from "@/server/settings/language.ts";
import { retentionDays, sizeBudgetBytes } from "@/server/settings/retention.ts";
import type { Setting } from "@/server/storage/settings.ts";
import type { Storage } from "@/server/storage/storage.ts";
import type { Restored } from "@/server/storage/transfer.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { dailyOfHours } from "@/shared/domain/rollup.ts";
import { channelDeclarations } from "@/shared/schemas/channel.ts";
import type { Check } from "@/shared/schemas/check.ts";
import {
  type Configuration,
  type ExportRecord,
  exportVersion,
  headerSchema,
  type ImportAnswer,
  recordSchema,
  type TravellingSetting,
  versionProbeSchema,
} from "@/shared/schemas/export.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import { pageImageMaxBytes } from "@/shared/schemas/page.ts";
import { reasons } from "@/shared/schemas/reason.ts";
import type { Rollup } from "@/shared/schemas/rollup.ts";
import { LongLineError, readLines, UnreadableFileError } from "./lines.ts";

/** Records gathered before one statement writes them. */
const batchSize = 500;

/** The imports under way, one chain per storage, so two never write at once. */
const chains = new WeakMap<Storage, Promise<unknown>>();

/** Reads a whole export into this install, or refuses it. */
export function importInstall(
  storage: Storage | undefined,
  key: InstallKey,
  file: ReadableStream<Uint8Array>,
  now: number
): Promise<ImportAnswer> {
  if (!storage) {
    file.cancel().catch(() => undefined);
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  const turn = (chains.get(storage) ?? Promise.resolve()).then(() =>
    importOnce(storage, key, file, now)
  );
  chains.set(
    storage,
    turn.catch(() => undefined)
  );
  return turn;
}

/** A refusal at a line of the file. */
class InvalidLineError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`the file is not an export at line ${line}`);
    this.name = "InvalidLineError";
    this.line = line;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller refuses the line.
  }
}

/** Each setting that travels, by its key, with the schema the install reads it through. */
const travelling: Readonly<Record<TravellingSetting, Setting<unknown>>> = {
  appearance_density: appearanceDensity,
  appearance_font_size: appearanceFontSize,
  appearance_radius: appearanceRadius,
  appearance_theme: appearanceTheme,
  calendar,
  clock,
  install_language: installLanguage,
  release_check_enabled: releaseCheckEnabled,
  retention_days: retentionDays,
  size_budget_bytes: sizeBudgetBytes,
  time_zone: timeZone,
};

/** Whether a setting's value fits the setting this install declares, so a file cannot store one the install would read as broken. */
function fitsItsSetting(row: Configuration["settings"][number]): boolean {
  return travelling[row.key].schema.safeParse(parseJson(row.value)).success;
}

/** Whether a channel's values are what its form would store: each field its type declares fits, the secret ones among its credentials and the rest in its config, and nothing else. */
function fitsItsForm(row: Configuration["channels"][number]): boolean {
  const config = valuesSchema.safeParse(parseJson(row.config)).data;
  const secrets =
    row.credentials === null
      ? {}
      : valuesSchema.safeParse(parseJson(row.credentials)).data;
  if (!(config && secrets)) {
    return false;
  }
  const declaration = channelDeclarations[row.type];
  const typed = { ...config, ...secrets };
  // A generated value comes from the file, never made here: one missing refuses the channel.
  const values = mergeValues(declaration, typed, typed, {
    generate: {},
    renew: false,
  });
  return (
    values !== undefined &&
    Bun.deepEquals(splitValues(declaration, values), { config, secrets })
  );
}

/** The page images as an upload takes them: within their kind's size, the type and hash computed from the bytes; nothing when one is no image of its kind. */
function takenImages(
  images: Configuration["pageImages"]
): Configuration["pageImages"] | undefined {
  const taken: Configuration["pageImages"] = [];
  for (const image of images) {
    const contentType = imageTypeOf(image.body, image.kind);
    if (
      contentType === undefined ||
      image.body.length > pageImageMaxBytes[image.kind]
    ) {
      return;
    }
    const hash = new Bun.CryptoHasher("sha256")
      .update(image.body)
      .digest("hex");
    taken.push({ ...image, contentType, hash });
  }
  return taken;
}

/** The configuration with every credential sealed with this install's key, and a webhook subscriber's address the SHA-256 of its URL. */
async function sealed(
  key: InstallKey,
  configuration: Configuration
): Promise<Configuration> {
  const seal = async <Row extends { credentials: string | null }>(
    row: Row
  ): Promise<Row> =>
    row.credentials === null
      ? row
      : { ...row, credentials: await encrypt(key, row.credentials) };
  return {
    ...configuration,
    channels: await Promise.all(configuration.channels.map(seal)),
    monitors: await Promise.all(configuration.monitors.map(seal)),
    subscriptions: await Promise.all(
      configuration.subscriptions.map(async (row) =>
        row.channel === "webhook" && row.credentials !== null
          ? {
              ...(await seal(row)),
              address: new Bun.CryptoHasher("sha256")
                .update(row.credentials)
                .digest("hex"),
            }
          : seal(row)
      )
    ),
  };
}

/** The install time zone the imported settings name, else this install's, for a heartbeat monitor's cron schedule when its days are sealed. */
async function importedTimeZone(
  storage: Storage,
  configuration: Configuration
): Promise<string> {
  const stored = configuration.settings.find((row) => row.key === timeZone.key);
  const parsed = timeZone.schema.safeParse(
    stored === undefined ? undefined : parseJson(stored.value)
  );
  return parsed.success ? parsed.data : (await readClock(storage)).timeZone;
}

async function importOnce(
  storage: Storage,
  key: InstallKey,
  file: ReadableStream<Uint8Array>,
  now: number
): Promise<ImportAnswer> {
  const lines = readLines(file);
  let line = 0;
  const next = async (): Promise<string | undefined> => {
    const read = await lines.next();
    if (read.done) {
      return;
    }
    line += 1;
    return read.value;
  };
  let restored: Restored | undefined;
  try {
    const first = await next();
    const json = first === undefined ? undefined : parseJson(first);
    const probe = versionProbeSchema.safeParse(json);
    if (!probe.success) {
      throw new InvalidLineError(1);
    }
    if (probe.data.version !== exportVersion) {
      return { ok: false, reason: "version" };
    }
    const header = headerSchema.safeParse(json);
    if (!header.success) {
      throw new InvalidLineError(1);
    }
    const { mode } = header.data;
    const pageImages = takenImages(header.data.configuration.pageImages);
    if (
      !(
        pageImages &&
        header.data.configuration.settings.every(fitsItsSetting) &&
        header.data.configuration.channels.every(fitsItsForm)
      )
    ) {
      throw new InvalidLineError(1);
    }
    const configuration = { ...header.data.configuration, pageImages };
    const zone = await importedTimeZone(storage, configuration);
    restored = await storage.transfer.restore(
      await sealed(key, { ...configuration, settings: [] })
    );
    if (!restored) {
      return { ok: false, reason: "not_empty" };
    }
    const monitors = new Set(configuration.monitors.map((row) => row.id));
    const history = historyWriter(storage, {
      monitors: await storage.monitors.list(),
      now,
      timeZone: zone,
    });
    let records = 0;
    // biome-ignore lint/performance/noAwaitInLoops: the file is read one line after another, each record written before the next is read
    for (let text = await next(); text !== undefined; text = await next()) {
      const record = recordSchema.safeParse(parseJson(text));
      if (
        mode === "configuration" ||
        !record.success ||
        !monitors.has(record.data.monitor)
      ) {
        throw new InvalidLineError(line);
      }
      records += 1;
      await history.take(record.data);
    }
    await history.finish();
    await storage.transfer.writeSettings(configuration.settings);
    return {
      monitors: configuration.monitors.length,
      ok: true,
      pages: configuration.statusPages.length,
      records,
    };
  } catch (error) {
    return await refused(storage, restored, error, line);
  } finally {
    await lines.return(undefined);
  }
}

/** Takes out what the import wrote and words why it stopped. */
async function refused(
  storage: Storage,
  restored: Restored | undefined,
  error: unknown,
  line: number
): Promise<ImportAnswer> {
  if (restored) {
    try {
      await storage.transfer.remove(restored);
    } catch (removal) {
      logError(
        `the import could not take out what it wrote: ${reasonOf(removal)}`
      );
      return { ok: false, reason: "unavailable" };
    }
  }
  if (error instanceof LongLineError) {
    return { line: error.line, ok: false, reason: "line_too_large" };
  }
  if (
    error instanceof InvalidLineError ||
    error instanceof UnreadableFileError
  ) {
    return { line: error.line, ok: false, reason: "invalid" };
  }
  // A write the database refused while it still answers is a file that does not hold together, such as a row pointing at none.
  try {
    await storage.changeCounter();
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  logError(`the import stopped at line ${line}: ${reasonOf(error)}`);
  return { line: Math.max(line, 1), ok: false, reason: "invalid" };
}

interface HistoryOptions {
  readonly monitors: Parameters<typeof sealClosedDays>[1]["monitors"];
  readonly now: number;
  readonly timeZone: string;
}

/**
 * Writes the records a batch at a time. When a monitor's records end, its
 * batches are written, a day it received as hours alone gets its daily
 * rollup summed from them, and its closed days are sealed as the nightly
 * job seals them, with its later checks in place for the day's edge.
 */
function historyWriter(storage: Storage, options: HistoryOptions) {
  let checks: Check[] = [];
  let outages: Outage[] = [];
  let hours: Rollup[] = [];
  let days: Rollup[] = [];
  let monitor: string | undefined;
  let hoursByDay = new Map<number, Rollup[]>();
  let rolledDays = new Set<number>();

  const flush = async () => {
    await storage.transfer.writeOutages(outages);
    await storage.transfer.writeChecks(checks);
    await storage.transfer.writeRollups("hour", hours);
    await storage.transfer.writeRollups("day", days);
    checks = [];
    outages = [];
    hours = [];
    days = [];
  };

  const finishMonitor = async () => {
    if (monitor === undefined) {
      return;
    }
    const summed = [...hoursByDay]
      .filter(([day]) => !rolledDays.has(day))
      .map(([day, rows]) => dailyOfHours(monitor ?? "", day, rows));
    days.push(...summed);
    await flush();
    await sealClosedDays(storage, {
      cutoff: utcDayStart(options.now),
      isStopped: () => false,
      monitors: options.monitors,
      now: options.now,
      timeZone: options.timeZone,
    });
    hoursByDay = new Map();
    rolledDays = new Set();
  };

  return {
    finish: finishMonitor,
    take: async (record: ExportRecord) => {
      if (record.monitor !== monitor) {
        await finishMonitor();
        ({ monitor } = record);
      }
      if (record.kind === "check") {
        checks.push({
          attempts: record.attempts,
          bytes: record.bytes,
          monitorId: record.monitor,
          reason: reasons[record.reason],
          responseMs: record.responseMs ?? undefined,
          result: record.result,
          startedAt: record.at,
          statusCode: record.statusCode ?? undefined,
        });
      } else if (record.kind === "outage") {
        outages.push({
          acknowledgedAt: record.acknowledgedAt ?? undefined,
          endedAt: record.endedAt ?? undefined,
          monitorId: record.monitor,
          reason: reasons[record.reason],
          startedAt: record.startedAt,
        });
      } else {
        const rollup: Rollup = {
          at: record.at,
          averageMs: record.averageMs ?? undefined,
          checks: record.checks,
          degraded: record.degraded,
          failed: record.failed,
          maxMs: record.maxMs ?? undefined,
          minMs: record.minMs ?? undefined,
          monitorId: record.monitor,
          observedMs: record.observedMs,
        };
        if (record.kind === "hourly") {
          hours.push(rollup);
          const day = utcDayStart(record.at);
          hoursByDay.set(day, [...(hoursByDay.get(day) ?? []), rollup]);
        } else {
          days.push(rollup);
          rolledDays.add(record.at);
        }
      }
      if (
        checks.length + outages.length + hours.length + days.length >=
        batchSize
      ) {
        await flush();
      }
    },
  };
}

/**
 * What a failure says without the values of the statement it ran: a
 * refused query's message lists every bound value, heartbeat and
 * subscription tokens and addresses among them, so a query's failure is its
 * driver's own message, which names the table or the constraint alone.
 */
