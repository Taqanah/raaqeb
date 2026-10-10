/**
 * The monitors module (CONTEXT.md "Monitor"): what the admin's
 * server functions call to create, edit, pause, resume and delete monitors,
 * to read the list and the form, and to run "test now". Every function
 * answers a result and never throws. Every write advances the
 * change counter: a monitor's name and paused state reach the public pages
 * through its components, and one rule is simpler than a list of
 * which writes count. Credentials are sealed here with the install key
 * before they reach the repository.
 */

import type { InstallKey } from "@/server/boot/installkey.ts";
import { maskCredentialText } from "@/server/checks/capture.ts";
import { certificateTarget } from "@/server/checks/certificate.ts";
import { answerText, secretsOf } from "@/server/checks/database.ts";
import { scheduleFires } from "@/server/checks/heartbeat.ts";
import type { LiveIo } from "@/server/checks/io.ts";
import { runCheck } from "@/server/checks/run.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import { readClock, readSetting } from "@/server/settings/clock.ts";
import { gettingStartedClosed } from "@/server/settings/getting-started.ts";
import { readRetentionDays } from "@/server/settings/retention.ts";
import { coveredMonitors } from "@/server/status/maintenance.ts";
import { ChannelShapeError } from "@/server/storage/channels.ts";
import { CheckShapeError } from "@/server/storage/checks.ts";
import { ComponentShapeError } from "@/server/storage/components.ts";
import { MaintenanceShapeError } from "@/server/storage/maintenance.ts";
import { MonitorShapeError } from "@/server/storage/monitors.ts";
import { OutageShapeError } from "@/server/storage/outages.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { connectionAddress } from "@/shared/domain/monitors.ts";
import type { ChannelChoice } from "@/shared/schemas/channel.ts";
import type { CheckOutcome, CheckResult } from "@/shared/schemas/check.ts";
import type { Component } from "@/shared/schemas/component.ts";
import {
  type Credentials,
  type CredentialsInput,
  noCredentials,
} from "@/shared/schemas/credentials.ts";
import {
  type HeartbeatView,
  heartbeatUrl,
} from "@/shared/schemas/heartbeat.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import {
  connectionUrlFits,
  type GettingStarted,
  isDatabaseCheckType,
  isDatabaseConfig,
  type Monitor,
  type MonitorBulkResult,
  type MonitorChange,
  type MonitorChoicesResult,
  type MonitorConfig,
  type MonitorFields,
  type MonitorFormResult,
  type MonitorInput,
  type MonitorListResult,
  type MonitorOriginal,
  type MonitorSaveResult,
  type MonitorTest,
  type MonitorTestResult,
} from "@/shared/schemas/monitor.ts";
import { observedMaxLength, reasonName } from "@/shared/schemas/reason.ts";
import {
  credentialsView,
  mergeCredentials,
  openCredentials,
  sealCredentials,
} from "./credentials.ts";
import { dayView, readMonitorDays } from "./days.ts";

type MonitorStorage = Pick<
  Storage,
  | "bump"
  | "certificates"
  | "channels"
  | "checks"
  | "components"
  | "heartbeats"
  | "maintenance"
  | "monitors"
  | "outages"
  | "pages"
  | "settings"
>;

const unavailable = { ok: false, reason: "unavailable" } as const;
const invalid = { ok: false, reason: "invalid" } as const;
const nonePosted: CredentialsInput = { headers: [] };

/**
 * The credentials a monitor of the input's check type stores, with every
 * left-out secret taken from the stored ones: an HTTP monitor's auth and
 * headers, a database monitor's connection URL, nothing for another type.
 * Nothing at all when a left-out secret has nothing stored, or the URL is
 * not one the check type reads (an edit to another database that kept the
 * old type's URL).
 */
function credentialsFor(
  input: MonitorInput,
  stored: Credentials | undefined
): Credentials | undefined {
  const { type } = input.config;
  if (isDatabaseCheckType(type)) {
    const url = input.credentials?.url ?? stored?.url;
    return url !== undefined && connectionUrlFits(type, url)
      ? { headers: [], url }
      : undefined;
  }
  return mergeCredentials(
    type === "http" ? (input.credentials ?? nonePosted) : nonePosted,
    stored
  );
}

/** The fields to store: a database monitor's address is written from its connection URL, whatever the form posted. */
function storedFields(
  input: MonitorInput,
  credentials: Credentials
): MonitorFields {
  const { credentials: _, ...fields } = input;
  const { config } = fields;
  const { url } = credentials;
  if (!isDatabaseConfig(config) || url === undefined) {
    return fields;
  }
  return {
    ...fields,
    config: { ...config, address: connectionAddress(config.type, url) },
  };
}

/** How many days each monitor's bar shows in the list. */
const listBarDays = 14;

export async function listMonitors(
  storage: MonitorStorage,
  now: number
): Promise<MonitorListResult> {
  try {
    const [monitors, latest, reach, channels, ongoing, closed] =
      await Promise.all([
        storage.monitors.list(),
        storage.checks.latest(),
        readReach(storage),
        channelChoices(storage).catch(noneUnreadable),
        storage.outages.ongoing().catch(noneUnreadable),
        readSetting(storage, gettingStartedClosed, false),
      ]);
    const covered = coveredMonitors(reach.windows, reach.components);
    // The state is the latest check's result; a monitor with no check yet has none.
    const states: Record<string, CheckResult> = {};
    for (const check of latest) {
      states[check.monitorId] = check.result;
    }
    // A heartbeat monitor's first check comes when its window closes, up to a day and its grace after a heartbeat: one read, only for those still waiting.
    const waiting = monitors
      .filter(
        (monitor) =>
          monitor.config.type === "heartbeat" && !(monitor.id in states)
      )
      .map((monitor) => monitor.id);
    const [heard, days, published] = await Promise.all([
      storage.heartbeats.latest(waiting),
      readMonitorDays(storage, monitors, { days: listBarDays, now }),
      // The checklist's one read of its own rides with the second batch, and a closed checklist skips it; a failed read leaves its line open and the list whole.
      closed ? true : storage.pages.anyPublished().catch(() => false),
    ]);
    const gettingStarted = closed
      ? undefined
      : stillOpen({
          channel: channels.length > 0,
          link: reach.components.some(
            (component) => component.monitorIds.length > 0
          ),
          monitor: monitors.length > 0,
          published,
        });
    if (!(closed || gettingStarted)) {
      // Every step done closes the checklist for good, written once; a failed write leaves the list whole and the next read tries again.
      await storage.settings
        .set(gettingStartedClosed, true)
        .catch(() => undefined);
    }
    return {
      acknowledgeable: Object.fromEntries(
        ongoing
          .filter((outage) => outage.acknowledgedAt === undefined)
          .map((outage) => [outage.monitorId, outage.startedAt])
      ),
      channels,
      days: Object.fromEntries(
        [...days].map(([id, each]) => [id, each.map(dayView)])
      ),
      covered: monitors
        .filter((monitor) => covered.has(monitor.id))
        .map((monitor) => monitor.id),
      gettingStarted,
      heard: [...heard.keys()],
      monitors,
      ok: true,
      states,
    };
  } catch (error) {
    // The one failure that is not the database's: a row this version cannot read, named so the operator can act on it.
    if (
      error instanceof MonitorShapeError ||
      error instanceof CheckShapeError
    ) {
      return { id: error.monitorId, ok: false, reason: "corrupt" };
    }
    return unavailable;
  }
}

/** The checklist while a line is open; none once every line is done. */
function stillOpen(lines: GettingStarted): GettingStarted | undefined {
  return Object.values(lines).every(Boolean) ? undefined : lines;
}

/** The command palette's read: every monitor's id, name and target, from one query, never the list read with its bars. */
export async function listMonitorChoices(
  storage: Pick<Storage, "monitors">
): Promise<MonitorChoicesResult> {
  try {
    return { monitors: await storage.monitors.choices(), ok: true };
  } catch {
    return unavailable;
  }
}

/** What a monitor's reach reads: every component's links, and the windows started and ending after `from`, or with no `from` the windows not completed. A window or component this version cannot read reads as none, which never flatters an uptime, and the pages that own it name it. */
export async function readReach(
  storage: Pick<Storage, "components" | "maintenance">,
  from?: number
): Promise<{
  readonly components: readonly Component[];
  readonly windows: readonly MaintenanceWindow[];
}> {
  const read =
    from === undefined
      ? storage.maintenance.unfinished()
      : storage.maintenance.since(from);
  const [windows, components] = await Promise.all([
    read.catch(noneUnreadable),
    storage.components.list().catch(noneUnreadable),
  ]);
  return { components, windows };
}

/** A record this version cannot read reads as none; any other failure stands. */
function noneUnreadable(error: unknown): never[] {
  if (
    error instanceof MaintenanceShapeError ||
    error instanceof ComponentShapeError ||
    error instanceof ChannelShapeError ||
    error instanceof OutageShapeError
  ) {
    return [];
  }
  throw error;
}

export async function createMonitor(
  storage: MonitorStorage,
  key: InstallKey,
  input: MonitorInput
): Promise<MonitorSaveResult> {
  // A new monitor has nothing stored, so a left-out secret cannot be kept.
  const credentials = credentialsFor(input, undefined);
  if (!credentials) {
    return invalid;
  }
  try {
    if (!(await fires(storage, input))) {
      return invalid;
    }
    const monitor = await storage.monitors.create(
      storedFields(input, credentials),
      await sealCredentials(key, credentials)
    );
    await storage.bump();
    return { monitor, ok: true };
  } catch {
    return unavailable;
  }
}

/** How an edit treats what the input does not carry. */
export interface EditOptions {
  /** A heartbeat monitor gets a new token; the old URL stops working. */
  readonly renewHeartbeatUrl?: boolean;
}

export async function editMonitor(
  storage: MonitorStorage,
  key: InstallKey,
  id: string,
  input: MonitorInput,
  options: EditOptions = {}
): Promise<MonitorSaveResult> {
  try {
    if (!(await fires(storage, input))) {
      return invalid;
    }
    const sealedBefore = await storage.monitors.credentialsOf(id);
    const stored =
      sealedBefore === undefined
        ? undefined
        : await openCredentials(key, sealedBefore);
    const credentials = credentialsFor(input, stored);
    if (!credentials) {
      return invalid;
    }
    // Credentials this key cannot open stay as they are when the edit posts none, so restoring the right key recovers them; typed ones replace them.
    const unreadable = sealedBefore !== undefined && stored === undefined;
    const none =
      credentials.auth === undefined &&
      credentials.headers.length === 0 &&
      credentials.url === undefined;
    const sealed =
      unreadable && none
        ? sealedBefore
        : await sealCredentials(key, credentials);
    const before = await findLenient(storage.monitors, id);
    // A new host, port or scheme, or the expiry option switched off, makes the record stale; without one the reader is due at once. Dropped before the write, so a write that fails costs a re-read, never a stale record.
    if (before && certificateHost(before) !== certificateHost(input)) {
      await storage.certificates.remove(id);
    }
    const monitor = await storage.monitors.update(
      id,
      storedFields(input, credentials),
      sealed,
      {
        renewHeartbeatToken: options.renewHeartbeatUrl,
      }
    );
    if (!monitor) {
      return { ok: false, reason: "not_found" };
    }
    await storage.bump();
    return { monitor, ok: true };
  } catch {
    return unavailable;
  }
}

/** Whether a heartbeat monitor's schedule fires in the install time zone; a cron expression for 30 February passes the grammar and never does. Any other check type fires. */
async function fires(
  storage: MonitorStorage,
  input: MonitorInput
): Promise<boolean> {
  if (input.config.type !== "heartbeat") {
    return true;
  }
  const { timeZone } = await readClock(storage);
  return scheduleFires(input.config.schedule, Date.now(), timeZone);
}

/** A stored heartbeat monitor's URL, at the public address or else the request's origin, and its last heartbeat; nothing for another check type. */
export async function heartbeatView(
  storage: Pick<Storage, "heartbeats" | "monitors" | "settings">,
  monitor: Monitor,
  requestOrigin: string | undefined
): Promise<HeartbeatView | undefined> {
  const token = await storage.monitors.heartbeatTokenOf(monitor.id);
  if (monitor.config.type !== "heartbeat" || token === undefined) {
    return;
  }
  const [address, latest] = await Promise.all([
    readPublicAddress(storage),
    storage.heartbeats.latest([monitor.id]),
  ]);
  return {
    last: latest.get(monitor.id),
    url: heartbeatUrl(address ?? requestOrigin ?? "", token),
  };
}

/** The form's read: the monitor to edit (none for a new one), the names of its credentials, a heartbeat monitor's URL and last heartbeat, the group and tag names to suggest, the channels to select, and the install's retention. The URL is at the public address, or at the request's origin when none is stored. A new monitor may duplicate `copy`: its fields and whether it has credentials, never them. */
export async function readMonitorForm(
  storage: MonitorStorage,
  key: InstallKey,
  id: string | undefined,
  requestOrigin: string | undefined,
  copy?: string
): Promise<MonitorFormResult> {
  try {
    const [names, retentionDefaultDays, channels, original] = await Promise.all(
      [
        storage.monitors.organization(),
        readRetentionDays(storage),
        channelChoices(storage),
        id === undefined && copy !== undefined
          ? readOriginal(storage, copy)
          : undefined,
      ]
    );
    const options = { ...names, channels, retentionDefaultDays };
    if (id === undefined) {
      return {
        credentials: noCredentials,
        heartbeat: undefined,
        monitor: undefined,
        ok: true,
        options,
        original,
      };
    }
    const monitor = await storage.monitors.find(id);
    if (!monitor) {
      return { ok: false, reason: "not_found" };
    }
    return {
      credentials: credentialsView(await storedCredentials(storage, key, id)),
      heartbeat: await heartbeatView(storage, monitor, requestOrigin),
      monitor,
      ok: true,
      options,
      original: undefined,
    };
  } catch (error) {
    if (error instanceof MonitorShapeError) {
      return { id: error.monitorId, ok: false, reason: "corrupt" };
    }
    return unavailable;
  }
}

/** Every channel a monitor may select, in creation order. */
async function channelChoices(
  storage: MonitorStorage
): Promise<ChannelChoice[]> {
  return (await storage.channels.list()).map((channel) => ({
    appliesToNew: channel.appliesToNew,
    id: channel.id,
    name: channel.name,
    type: channel.type,
  }));
}

/** The monitor's stored credentials, or nothing when it has none or this install's key cannot open them (they read as none, and typing them again repairs them). */
async function storedCredentials(
  storage: MonitorStorage,
  key: InstallKey,
  id: string
): Promise<Credentials | undefined> {
  const sealed = await storage.monitors.credentialsOf(id);
  return sealed === undefined ? undefined : openCredentials(key, sealed);
}

/** The monitor a duplicate starts from, or nothing when it no longer exists. Its credentials are never opened: only whether it has any is read. */
async function readOriginal(
  storage: MonitorStorage,
  id: string
): Promise<MonitorOriginal | undefined> {
  const [monitor, sealed] = await Promise.all([
    storage.monitors.find(id),
    storage.monitors.credentialsOf(id),
  ]);
  return monitor && { hadCredentials: sealed !== undefined, monitor };
}

/**
 * "Test now": runs one check of the form as it stands, as the scheduler
 * would, and records nothing: no row, no outage, no event, no bump. A
 * secret the form left out is read from the monitor it edits. It also
 * answers what the check's I/O saw that a row never keeps: the address a
 * TCP check connected to, the records a DNS check's resolver answered, the
 * value a database check's query answered.
 */
export async function testMonitor(
  storage: MonitorStorage,
  key: InstallKey,
  io: LiveIo,
  input: MonitorInput,
  id: string | undefined
): Promise<MonitorTestResult> {
  // A form that leaves no secret out needs nothing stored; one that does needs the monitor it edits.
  let credentials = credentialsFor(input, undefined);
  if (!credentials && id !== undefined) {
    try {
      credentials = credentialsFor(
        input,
        await storedCredentials(storage, key, id)
      );
    } catch {
      return unavailable;
    }
  }
  if (!credentials) {
    return invalid;
  }
  // What the one attempt's connection or query answered, which no check row keeps.
  const seen: {
    address?: string;
    answer?: string;
    records?: readonly string[];
  } = {};
  const watched: LiveIo = {
    ...io,
    connect: async (target) => {
      seen.address = await io.connect(target);
      return seen.address;
    },
    queryDatabase: async (query) => {
      const answer = await io.queryDatabase(query);
      seen.answer = maskCredentialText(
        answerText(answer),
        secretsOf(query.url)
      ).slice(0, observedMaxLength);
      return answer;
    },
    resolve: async (query) => {
      seen.records = await io.resolve(query);
      return seen.records;
    },
  };
  // One attempt, so the answer comes within the timeout; the response is kept as "always" would keep it, and dropped with the answer.
  const run = runCheck(
    {
      config: testConfig(input.config),
      credentials,
      degradedMs: input.degradedMs,
      id: id ?? "test",
      retries: 0,
      timeoutMs: input.timeoutMs,
    },
    watched
  );
  if (!run) {
    return invalid;
  }
  return { ok: true, test: { ...testOf(await run), ...seen } };
}

function testConfig(config: MonitorConfig): MonitorConfig {
  return config.type === "http" ? { ...config, captureMode: "always" } : config;
}

/** What the form shows of one check: the row, the failure detail and the capture, never a credential. */
function testOf({ capture, check, detail }: CheckOutcome): MonitorTest {
  return {
    bytes: check.bytes,
    failure: detail && {
      assertion: detail.assertion,
      error: detail.error,
      params: detail.params,
    },
    reason: reasonName(check.reason) ?? "unknown",
    response: capture && {
      body: new TextDecoder().decode(capture.body),
      headers: capture.headers,
    },
    responseMs: check.responseMs,
    result: check.result,
    statusCode: check.statusCode,
  };
}

/** The monitor before an edit, or nothing when its stored config no longer parses: the edit repairs such a row (its record, if any, is left to the reader's next pass). */
async function findLenient(
  monitors: Storage["monitors"],
  id: string
): Promise<Monitor | undefined> {
  try {
    return await monitors.find(id);
  } catch (error) {
    if (error instanceof MonitorShapeError) {
      return;
    }
    throw error;
  }
}

/** `host:port` of the monitor's certificate target, or nothing when the monitor has none. */
function certificateHost(
  monitor: Pick<Monitor, "config"> | undefined
): string | undefined {
  const target = monitor && certificateTarget(monitor);
  return target && `${target.host}:${target.port}`;
}

/** Pauses the monitors; the repository ends their open outages at the pause time in the same write. */
export function pauseMonitors(
  storage: MonitorStorage,
  ids: readonly string[]
): Promise<MonitorBulkResult> {
  return bulk(storage, (monitors) => monitors.pause(ids));
}

export function resumeMonitors(
  storage: MonitorStorage,
  ids: readonly string[]
): Promise<MonitorBulkResult> {
  return bulk(storage, (monitors) => monitors.resume(ids));
}

/** Makes one change to every one of these monitors: a channel, the group or a tag. A monitor that already has it, or lacks what is removed, is left as it is; adding a channel leaves the monitor's events as they are, as selecting one in the form does. The change counter moves only when a monitor changed. */
export function changeMonitors(
  storage: MonitorStorage,
  ids: readonly string[],
  change: MonitorChange
): Promise<MonitorBulkResult> {
  return bulk(
    storage,
    async (monitors) => {
      switch (change.kind) {
        case "add_channel":
          return (
            (await monitors.addChannel(ids, change.channel)) ?? {
              ok: false,
              reason: "not_found",
            }
          );
        case "remove_channel":
          return monitors.removeChannel(ids, change.channel);
        case "set_group":
          return monitors.setGroup(ids, change.group);
        case "add_tag":
          return (
            (await monitors.addTag(ids, change.tag)) ?? {
              ok: false,
              reason: "tags_full",
            }
          );
        case "remove_tag":
          return monitors.removeTag(ids, change.tag);
        default:
          return change satisfies never;
      }
    },
    // A change that changed no monitor leaves the public memo as it is.
    true
  );
}

export function deleteMonitors(
  storage: MonitorStorage,
  ids: readonly string[]
): Promise<MonitorBulkResult> {
  return bulk(storage, (monitors) => monitors.remove(ids));
}

/** One write over many monitors: the count it answers moves the change counter once; a refusal wrote nothing and moves nothing, and with `onlyWhenChanged` neither does a write that changed no monitor. */
async function bulk(
  storage: MonitorStorage,
  act: (
    monitors: Storage["monitors"]
  ) => Promise<number | Extract<MonitorBulkResult, { ok: false }>>,
  onlyWhenChanged = false
): Promise<MonitorBulkResult> {
  try {
    const count = await act(storage.monitors);
    if (typeof count !== "number") {
      return count;
    }
    if (count > 0 || !onlyWhenChanged) {
      await storage.bump();
    }
    return { count, ok: true };
  } catch {
    return unavailable;
  }
}
