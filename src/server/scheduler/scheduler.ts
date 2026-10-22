/**
 * The scheduler (CONTEXT.md "Check", "Outage"): on the
 * one event loop, once a tick, it picks up what the operator changed, starts
 * the checks that are due, and settles each as it ends: records the row, the
 * failure detail and the capture, opens or closes the outage, raises the
 * monitor events, and moves the change counter on a transition and on
 * every failing check while down. Six parts own their state and timing
 * and are handed the tick's time: the maintenance pass (`maintenance.ts`)
 * moves the windows at their edges before the checks start; the
 * certificate reader's pass (`certificates.ts`), the registration pass
 * (`registrations.ts`), the nightly job (`nightly.ts`) and the
 * notification queue's drain (`notify/queue.ts`) run beside the checks; and before a check's row is written the size
 * guard (`budget.ts`) holds the history under the size budget and the
 * reserve.
 * Every check and timer stays on this loop;
 * no worker threads. The watchdog judges the last tick and asks the entry
 * to exit when it is five minutes old.
 */

import { purgeAudit } from "@/server/audit/audit.ts";
import type { InstallKey } from "@/server/boot/installkey.ts";
import {
  evaluateHeartbeat,
  heartbeatsKept,
} from "@/server/checks/heartbeat.ts";
import type { LiveIo } from "@/server/checks/io.ts";
import { createRegistrationReader } from "@/server/checks/registration.ts";
import { runCheck } from "@/server/checks/run.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import { openCredentials } from "@/server/monitors/credentials.ts";
import { createOperatorNotifications } from "@/server/notify/operator.ts";
import { createNotificationQueue } from "@/server/notify/queue.ts";
import {
  createSubscriberNotifications,
  type SubscriberNotifications,
} from "@/server/notify/subscribers.ts";
import { readPublicAddress } from "@/server/settings/address.ts";
import { readClock } from "@/server/settings/clock.ts";
import { CheckShapeError } from "@/server/storage/checks.ts";
import { MonitorShapeError } from "@/server/storage/monitors.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { hostTimeZone } from "@/shared/i18n/timezone.ts";
import type { CheckOutcome, CheckResult } from "@/shared/schemas/check.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import type { CheckAsked } from "@/shared/schemas/detail.ts";
import type { Heartbeat } from "@/shared/schemas/heartbeat.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";
import {
  checkableByProbe,
  isDatabaseCheckType,
  locationsOf,
  type Monitor,
  mainLocation,
} from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import {
  type LocationState,
  type ProbeAssignments,
  type ProbeResult,
  probeProtocol,
  probeSilentAfterMs,
} from "@/shared/schemas/probe.ts";
import { confirmationLifetimeMs } from "@/shared/schemas/subscription.ts";
import { createSizeGuard } from "./budget.ts";
import { createCertificatePass } from "./certificates.ts";
import { type Liveness, tickVerdict } from "./health.ts";
import {
  freshForMs,
  isKnown,
  type LocationResult,
  locationResultFromProbe,
  locationResultOf,
  verdictOf,
  verdictOutcome,
} from "./locations.ts";
import { createMaintenancePass } from "./maintenance.ts";
import { createNightlyJob } from "./nightly.ts";
import { createRegistrationPass } from "./registrations.ts";
import {
  afterCheck,
  arrivedWhileDown,
  bringForward,
  dueMonitors,
  eventsOf,
  failedWhileUp,
  type MonitorEvent,
  movesCounter,
  reconcileSchedule,
  refreshPeriodMs,
  type Schedule,
  type ScheduleEntry,
  type SeenFrom,
  spreadFirstRuns,
  tickPeriodMs,
} from "./schedule.ts";

/** The credentials a probe needs for the monitor's check type, and no other: an HTTP request's auth (an OAuth 2.0 client secret included), client certificate key, headers and proxy sign-in, a database monitor's connection URL. */
function sentWith(
  monitor: Monitor,
  held: Credentials | undefined
): Credentials | undefined {
  if (!held) {
    return;
  }
  if (monitor.config.type === "http") {
    return {
      ...(held.auth && { auth: held.auth }),
      ...(held.clientKey && { clientKey: held.clientKey }),
      headers: held.headers,
      ...(held.proxyAuth && { proxyAuth: held.proxyAuth }),
    };
  }
  return isDatabaseCheckType(monitor.config.type) && held.url !== undefined
    ? { headers: [], url: held.url }
    : undefined;
}

/** What the scheduler needs of storage; the storage module satisfies it. */
export type SchedulerStorage = Pick<
  Storage,
  | "audit"
  | "bump"
  | "certificates"
  | "changeCounter"
  | "channels"
  | "checks"
  | "components"
  | "heartbeats"
  | "incidents"
  | "maintenance"
  | "monitors"
  | "notifications"
  | "outages"
  | "pages"
  | "probes"
  | "registrations"
  | "settings"
  | "size"
  | "subscriptions"
>;

/** A run's check, and for a monitor checked from several locations the ones that saw it down. */
interface Settled {
  readonly locations?: readonly SeenFrom[];
  readonly outcome: CheckOutcome;
}

/** A check the reserve refuses is logged at most this often. */
const refusedLogPeriodMs = 60_000;

/** The watchdog looks at the last tick this often. */
export const watchdogPeriodMs = 30_000;

export interface SchedulerOptions {
  /** How often the certificate reader's pass runs; the reader itself decides what is due. */
  readonly certificatePeriodMs?: number;
  /** Opens each HTTP monitor's sealed credentials when the monitors are read. */
  readonly installKey: InstallKey;
  /** How often the size guard measures before a check's row is written. */
  readonly measurePeriodMs?: number;
  /** Called with every monitor event, raised by a settled check, the certificate pass or the registration pass; the entry logs them. Their notifications go to the queue whatever this does. */
  readonly onEvent?: (event: MonitorEvent) => void;
  /** Called with each maintenance window the scheduler moved, in its new stage; the entry logs them. */
  readonly onMaintenance?: (window: MaintenanceWindow) => void;
  /** Called by the watchdog when the last tick is older than the exit bound; the entry exits. */
  readonly onStale?: (sinceMs: number) => void;
  /** How often the tick moves the change counter with nothing else changed; five minutes by default. */
  readonly refreshPeriodMs?: number;
  readonly tickPeriodMs?: number;
  /** How often the watchdog looks at the last tick. */
  readonly watchdogPeriodMs?: number;
}

/** "Check now": the monitor's next scheduled check runs at the next tick, recorded like any other. */
export interface CheckRequests {
  /** Asks for the monitor's check at the next tick; `running` when one is already in flight, which the caller waits for instead. The caller refuses a paused or heartbeat monitor first; the tick skips one all the same. */
  readonly checkNow: (monitorId: string) => CheckAsked;
}

/** An outage the operator acknowledged: its reminders stop at once, before the next pass reads anything. */
export interface OutageRequests {
  readonly acknowledge: (outage: Outage) => void;
}

/** What a route may ask of the subscriber notifications: an event to announce, a confirmation to send. */
export interface SubscriberRequests {
  readonly subscribers: Pick<SubscriberNotifications, "announce" | "confirm">;
}

/** What the probe API and a monitor's page ask of the locations (ADR-0012). */
export interface LocationRequests {
  /** A probe's assignments: its unpaused monitors of a check type it runs, with their opened credentials only when they share them; nothing until the monitors were read. */
  readonly assignmentsOf: (probeId: string) => ProbeAssignments | undefined;
  /** Each location's state for a monitor checked from more than one, in its order; nothing for one checked from the main location alone. */
  readonly locationStates: (monitorId: string) => LocationState[] | undefined;
  /** Takes a probe's results as received at `receivedAt`: one for a monitor not assigned to it, or older than the state held, is dropped; one that would change the monitor's verdict brings its next run to the next tick. */
  readonly report: (
    probeId: string,
    results: readonly ProbeResult[],
    receivedAt: number
  ) => void;
}

export interface Scheduler
  extends Liveness,
    CheckRequests,
    LocationRequests,
    OutageRequests,
    SubscriberRequests {
  /** Resolves once no check is in flight; tests wait on it. */
  idle: () => Promise<void>;
  /** Ticks now and then every period, and starts the watchdog. */
  start: () => void;
  /** Stops the timers and waits for a settlement already under way; a check still in flight is not recorded. */
  stop: () => Promise<void>;
  /** One tick: reads what changed, starts the due checks, runs the certificate and registration passes and the nightly job when their time has come. */
  tick: () => Promise<void>;
  /** The watchdog's look: calls `onStale` when the last tick is older than the exit bound. */
  watch: () => void;
}

export function createScheduler(
  storage: SchedulerStorage,
  io: LiveIo,
  options: SchedulerOptions
): Scheduler {
  const tickPeriod = options.tickPeriodMs ?? tickPeriodMs;
  const watchdogPeriod = options.watchdogPeriodMs ?? watchdogPeriodMs;
  const refreshPeriod = options.refreshPeriodMs ?? refreshPeriodMs;

  let schedule: Schedule | undefined;
  /** Every monitor as last read, paused ones included, for the certificate pass and the nightly job. */
  let monitors: readonly Monitor[] = [];
  /** The opened credentials of the monitors as last read, by id. */
  let credentials: ReadonlyMap<string, Credentials> = new Map();
  /** The install time zone a cron schedule is read in, as last read with the monitors. */
  let timeZone = hostTimeZone();
  /** Whether the monitors were read once: until then the reminder pass would drop every open outage for a monitor it cannot see. */
  let monitorsRead = false;
  /** The stored public address the notifications' links point at, as last read with the monitors. */
  let publicAddress: string | undefined;
  /** The change counter as the scheduler last saw it; a value it did not expect means the operator changed something. */
  let known: number | undefined;
  let lastTickAt: number | undefined;
  /** The first tick's time: the held states start empty there. */
  let bootAt: number | undefined;
  /** When the tick last moved the counter for the figures that follow the clock alone. */
  let refreshedAt: number | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  /** Each probe's name as last read with the monitors, by id. */
  let probeNames: ReadonlyMap<string, string> = new Map();
  /** When the install last heard from each probe: a pull or a push; a probe first known at boot or when made counts from then. */
  const heard = new Map<string, number>();
  /** The probes whose silence the channels were told of. */
  const silent = new Set<string>();
  /** The probe notifications being queued, one after another; idle and stop wait for them. */
  let telling: Promise<void> = Promise.resolve();
  /** Each location's latest result, by monitor and location, for the monitors checked from more than one (ADR-0012). */
  const held = new Map<string, Map<string, LocationResult>>();
  /** The state before the next check of each monitor, seeded once from the latest checks. */
  const states = new Map<string, CheckResult>();
  let statesSeeded = false;
  const inFlight = new Map<string, Promise<void>>();
  /** When each check in flight started, by monitor; its row starts then or later. */
  const flightStarts = new Map<string, number>();
  /** The monitors "check now" asked for since the last tick; the tick brings them forward once. */
  const requested = new Set<string>();
  /** The settlements past their stop guard, whose writes stop waits for. */
  const settling = new Set<Promise<void>>();
  let refusedLoggedAt: number | undefined;
  /** Own bumps run one after another, so each can tell whether the counter moved by exactly its one. */
  let bumps: Promise<void> = Promise.resolve();

  /** Reads the monitors, then the maintenance windows and their links, whatever the monitors did; answers whether both reads are settled. Every window write moves the counter, so the windows are read here too. */
  async function readMonitors(now: number): Promise<boolean> {
    const settled = await readMonitorRows(now);
    return (await maintenance.read()) && settled;
  }

  /** Reads the monitors and answers whether the read is settled: a row this version cannot read stays so until the operator acts, any other failure is tried again next tick. */
  async function readMonitorRows(now: number): Promise<boolean> {
    try {
      // The time zone reads a cron schedule; saving it moves the counter, which brings the scheduler here.
      ({ timeZone } = await readClock(storage));
      // Saving the general settings moves the counter too, so a new public address is read here.
      publicAddress = await readPublicAddress(storage);
      const seen = new Set(monitors.map((monitor) => monitor.id));
      monitors = await storage.monitors.list();
      credentials = await openAll(await storage.monitors.allCredentials());
      probeNames = new Map(
        (await storage.probes.list()).map((probe) => [probe.id, probe.name])
      );
      for (const id of probeNames.keys()) {
        if (!heard.has(id)) {
          heard.set(id, now);
        }
      }
      forgetLocations();
      if (monitorsRead && monitors.some((monitor) => !seen.has(monitor.id))) {
        // A monitor may arrive with its history, as an import writes it: its latest check and its open outage are read as at boot.
        statesSeeded = false;
        operator.adopt();
      }
      monitorsRead = true;
      schedule = schedule
        ? reconcileSchedule(schedule, monitors, now, timeZone)
        : spreadFirstRuns(monitors, now, timeZone);
      return true;
    } catch (error) {
      // A row this version cannot read names the monitor; the schedule stays as it was.
      logError(
        `the scheduler keeps its monitors as they were: ${reasonOf(error)}`
      );
      const settled = error instanceof MonitorShapeError;
      // A row this version cannot read makes an empty schedule at boot, read again when the operator acts; a blip leaves none, so the read that succeeds still spreads the first runs.
      if (settled) {
        schedule ??= new Map();
      }
      return settled;
    }
  }

  /** Drops the results of locations a monitor is no longer checked from, and of monitors gone or checked from the main location alone. */
  function forgetLocations(): void {
    const located = new Map(
      monitors
        .filter((monitor) => monitor.locations !== undefined)
        .map((monitor) => [monitor.id, new Set(locationsOf(monitor))])
    );
    for (const [monitorId, results] of held) {
      const wanted = located.get(monitorId);
      if (!wanted) {
        held.delete(monitorId);
        continue;
      }
      for (const location of results.keys()) {
        if (!wanted.has(location)) {
          results.delete(location);
        }
      }
    }
  }

  function heldOf(monitorId: string): Map<string, LocationResult> {
    let results = held.get(monitorId);
    if (!results) {
      results = new Map();
      held.set(monitorId, results);
    }
    return results;
  }

  /** The check a run writes for a monitor checked from several locations: their verdict at `startedAt`, or nothing when no location's state is known. */
  function confirmed(
    monitor: Monitor,
    startedAt: number,
    own: CheckOutcome | undefined
  ): Settled | undefined {
    const results = heldOf(monitor.id);
    const now = io.now();
    const verdict = verdictOf(monitor, results, now);
    if (!verdict) {
      return;
    }
    // After a restart the held states are empty: a down that fewer locations than the count decide waits until each had its time to answer.
    if (
      verdict.result === "down" &&
      verdict.known < (monitor.confirmations ?? 1) &&
      now < (bootAt ?? now) + freshForMs(monitor)
    ) {
      return;
    }
    return {
      locations: verdict.down.map((id) => ({
        id,
        name: id === mainLocation ? undefined : probeNames.get(id),
      })),
      outcome: verdictOutcome(monitor.id, verdict, results, startedAt, own),
    };
  }

  /** Opens every monitor's sealed credentials; ones the key cannot open are logged by monitor and not sent, so the check still runs and shows what the target answers without them. */
  async function openAll(
    sealed: ReadonlyMap<string, string>
  ): Promise<Map<string, Credentials>> {
    const opened = new Map<string, Credentials>();
    const { installKey } = options;
    for (const [id, text] of sealed) {
      // biome-ignore lint/performance/noAwaitInLoops: one small decrypt per credentialed monitor, only when the operator changed something
      const open = await openCredentials(installKey, text);
      if (open) {
        opened.set(id, open);
      } else {
        logError(
          `the credentials of the monitor ${id} cannot be opened with this install key; its checks run without them`
        );
      }
    }
    return opened;
  }

  /** Seeds the state of each monitor the scheduler does not know yet before its next check; a failed read is tried again next tick, a row this version cannot read is logged and given up on. */
  async function seedStates(): Promise<boolean> {
    try {
      for (const check of await storage.checks.latest()) {
        if (!states.has(check.monitorId)) {
          states.set(check.monitorId, check.result);
        }
      }
      return true;
    } catch (error) {
      logError(
        `the scheduler could not read the latest checks: ${reasonOf(error)}`
      );
      return error instanceof CheckShapeError;
    }
  }

  function bump(): Promise<void> {
    bumps = bumps
      .then(async () => {
        const value = await storage.bump();
        // Any other move leaves `known` behind, so the next tick re-reads the monitors.
        if (known !== undefined && value === known + 1) {
          known = value;
        }
      })
      .catch((error: unknown) => {
        logError(`the change counter did not move: ${reasonOf(error)}`);
      });
    return bumps;
  }

  /** Holds the history under the size budget and the SQLite reserve before a check's row is written. */
  const guard = createSizeGuard(storage, {
    bump,
    measurePeriodMs: options.measurePeriodMs,
  });

  const isStopped = () => stopped;

  /** The notification queue's drain, on the same tick. */
  const queue = createNotificationQueue(storage, io, {
    installKey: options.installKey,
    isStopped,
  });

  /** The monitor events' notifications and the reminders while a monitor stays down, none while a window covers it. */
  const operator = createOperatorNotifications(storage, queue, {
    context: () => ({ publicAddress }),
    covers: (monitorId) => maintenance.covers(monitorId),
    isStopped,
  });

  /** The subscriber notifications: the events routes and the maintenance pass announce, and the confirmations of sign-ups, through the same queue. */
  const subscribers = createSubscriberNotifications(storage, queue, {
    isStopped,
  });

  /** Moves each maintenance window at its start and its end, schedules each series' occurrences a week ahead, and hands on the monitors a completed window left uncovered for their down notification; each move is a subscriber event. */
  const maintenance = createMaintenancePass(storage, {
    bump,
    isStopped,
    onMoved: (window) => {
      options.onMaintenance?.(window);
      subscribers
        .announce(
          {
            type:
              window.stage === "completed"
                ? "maintenance.completed"
                : "maintenance.started",
            windowId: window.id,
          },
          io.now()
        )
        .catch(() => undefined);
    },
    onUncovered: (monitorIds, now) =>
      operator.uncovered(monitorIds, now, monitors),
  });

  /** Reads the due certificates over the monitors the tick already read, one connection at a time, beside the checks and never in their way; raises each certificate warning that falls due. */
  const certificates = createCertificatePass(storage, io, {
    covers: (monitorId) => maintenance.covers(monitorId),
    isStopped,
    onExpiring: async (event) => {
      options.onEvent?.(event);
      const monitor = monitors.find((each) => each.id === event.monitorId);
      if (monitor && !(await operator.raise(event, monitor, io.now()))) {
        throw new Error("its notification was not queued");
      }
    },
    periodMs: options.certificatePeriodMs,
  });

  /** Reads the due domain registrations over the monitors the tick already read, one at a time, beside the checks and never in their way; raises each domain expiring warning that falls due. */
  const registrations = createRegistrationPass(
    storage,
    createRegistrationReader(io),
    {
      covers: (monitorId) => maintenance.covers(monitorId),
      isStopped,
      onExpiring: async (event) => {
        options.onEvent?.(event);
        const monitor = monitors.find((each) => each.id === event.monitorId);
        if (monitor && !(await operator.raise(event, monitor, io.now()))) {
          throw new Error("its notification was not queued");
        }
      },
    }
  );

  /** Once a closed day is safe to seal, the sealing pass and then the purge, beside the checks. */
  const nightly = createNightlyJob(storage, {
    bump,
    expire: async (now) => {
      await storage.subscriptions.expire(now - confirmationLifetimeMs);
      // Audit entries past the install's retention go with the day's purge.
      await purgeAudit(storage, now);
    },
    isStopped,
  });

  async function settle(monitor: Monitor, settled: Settled): Promise<void> {
    if (stopped) {
      return;
    }
    const { outcome } = settled;
    const { check } = outcome;
    const now = io.now();
    if (await guard.admit(now)) {
      await storage.checks.record(outcome);
    } else if (
      refusedLoggedAt === undefined ||
      now - refusedLoggedAt >= refusedLogPeriodMs
    ) {
      refusedLoggedAt = now;
      logError(
        `the check of the monitor ${monitor.id} was not recorded: the free disk is under the 64 MB reserve and no history is left to delete`
      );
    }
    const previous = states.get(monitor.id);
    states.set(monitor.id, check.result);
    const opened =
      check.result === "down" &&
      (await storage.outages.open(monitor.id, check.startedAt, check.reason));
    const closed =
      check.result === "down"
        ? undefined
        : await storage.outages.close(monitor.id, check.startedAt);
    const { detail } = outcome;
    // What the failing heartbeat behind a heartbeat_failed check carried, for the notification.
    const failure =
      detail?.params.reason === "heartbeat_failed"
        ? { exitCode: detail.params.exitCode, message: detail.error }
        : undefined;
    const settlement = {
      check,
      closed,
      failure,
      locations: settled.locations,
      opened,
      previous,
    };
    for (const event of eventsOf(settlement)) {
      options.onEvent?.(event);
      // biome-ignore lint/performance/noAwaitInLoops: a settlement raises at most two events, queued in order
      await operator.raise(event, monitor, now);
    }
    if (movesCounter(settlement)) {
      await bump();
    }
  }

  /** A heartbeat monitor's run: its window's one check from the latest heartbeat, or from the failing heartbeat that brought the evaluation forward, then the heartbeats past the latest hundred go. */
  async function evaluateWindow(
    entry: ScheduleEntry,
    now: number,
    failed?: Heartbeat
  ): Promise<CheckOutcome> {
    const { id } = entry.monitor;
    // Only what arrived before this evaluation's time: a heartbeat landing while it reads belongs to the next window.
    const latest = failed
      ? new Map([[id, failed]])
      : await storage.heartbeats.latest([id], now);
    await storage.heartbeats
      .prune(id, heartbeatsKept)
      .catch((error: unknown) => {
        logError(
          `the heartbeats of the monitor ${id} were not pruned: ${reasonOf(error)}`
        );
      });
    return evaluateHeartbeat({
      graceMs: entry.graceMs,
      lastArrivedAt: latest.get(id)?.arrivedAt,
      lastFailure: latest.get(id)?.failure,
      monitorId: id,
      now,
      since: entry.since,
    });
  }

  function runOf(
    monitor: Monitor,
    now: number,
    failed?: Heartbeat
  ): Promise<Settled | undefined> | undefined {
    if (monitor.config.type === "heartbeat") {
      const entry = schedule?.get(monitor.id);
      return (
        entry &&
        evaluateWindow(entry, now, failed).then((outcome) => ({ outcome }))
      );
    }
    if (
      monitor.locations !== undefined &&
      !monitor.locations.includes(mainLocation)
    ) {
      // Checked from probes alone: the run is their verdict as it stands.
      return Promise.resolve(confirmed(monitor, now, undefined));
    }
    const run = runCheck(
      { ...monitor, credentials: credentials.get(monitor.id) },
      io
    );
    if (monitor.locations === undefined) {
      return run?.then((outcome) => ({ outcome }));
    }
    return run?.then((own) => {
      heldOf(monitor.id).set(mainLocation, locationResultOf(own));
      return confirmed(monitor, own.check.startedAt, own);
    });
  }

  /** The channels of the unpaused monitors a probe checks: where its silence is told. */
  function probeChannels(probeId: string): string[] {
    const ids = new Set<string>();
    for (const monitor of monitors) {
      if (!monitor.paused && monitor.locations?.includes(probeId)) {
        for (const channel of monitor.channels) {
          ids.add(channel);
        }
      }
    }
    return [...ids];
  }

  /** Queues a probe's silence or its return for the channels of the monitors it checks; a refusal is logged. */
  function tellProbe(
    type: "probe.reporting" | "probe.silent",
    probeId: string,
    lastHeardAt: number,
    now: number
  ): void {
    const channels = probeChannels(probeId);
    if (channels.length === 0) {
      return;
    }
    const payload = {
      data: {
        lastHeardAt: new Date(lastHeardAt).toISOString(),
        probe: { id: probeId, name: probeNames.get(probeId) ?? probeId },
      },
      timestamp: new Date(now).toISOString(),
      type,
    };
    const tell = async () => {
      try {
        await queue.enqueue(channels, payload, now);
      } catch (error) {
        logError(
          `the ${type} notification of the probe ${probeId} was not queued: ${reasonOf(error)}`
        );
      }
    };
    telling = telling.then(tell);
  }

  /** A request from the probe: it is heard, and a silence told is ended. */
  function hear(probeId: string, now: number): void {
    const before = heard.get(probeId);
    heard.set(probeId, now);
    if (silent.delete(probeId)) {
      tellProbe("probe.reporting", probeId, before ?? now, now);
    }
  }

  /** On the tick: each probe not heard from for two minutes is told of once. */
  function watchProbes(now: number): void {
    for (const [id, at] of heard) {
      if (!probeNames.has(id)) {
        heard.delete(id);
        silent.delete(id);
        continue;
      }
      if (!silent.has(id) && now - at >= probeSilentAfterMs) {
        silent.add(id);
        tellProbe("probe.silent", id, at, now);
      }
    }
  }

  function report(
    probeId: string,
    results: readonly ProbeResult[],
    receivedAt: number
  ): void {
    hear(probeId, receivedAt);
    for (const result of results) {
      const monitor = monitors.find((each) => each.id === result.monitorId);
      if (
        !monitor ||
        monitor.paused ||
        !monitor.locations?.includes(probeId) ||
        !checkableByProbe(monitor.config.type)
      ) {
        continue;
      }
      const state = locationResultFromProbe(result, receivedAt);
      const located = heldOf(monitor.id);
      const before = located.get(probeId);
      // A check from before the monitor last changed checked what it no longer is.
      if (
        state.startedAt < monitor.updatedAt ||
        (before && before.startedAt >= state.startedAt)
      ) {
        continue;
      }
      located.set(probeId, state);
      const verdict = verdictOf(monitor, located, receivedAt);
      if (verdict && verdict.result !== states.get(monitor.id)) {
        // The install checks again at once, so an agreeing location opens the outage within a tick.
        requested.add(monitor.id);
      }
    }
  }

  function assignmentsOf(probeId: string): ProbeAssignments | undefined {
    if (!monitorsRead) {
      return;
    }
    if (probeNames.has(probeId)) {
      hear(probeId, io.now());
    }
    return {
      monitors: monitors
        .filter(
          (monitor) =>
            !monitor.paused &&
            monitor.locations?.includes(probeId) &&
            checkableByProbe(monitor.config.type)
        )
        .map((monitor) => ({
          config: monitor.config,
          credentials: monitor.shareCredentials
            ? sentWith(monitor, credentials.get(monitor.id))
            : undefined,
          degradedMs: monitor.degradedMs,
          id: monitor.id,
          intervalMs: monitor.intervalMs,
          retries: monitor.retries,
          timeoutMs: monitor.timeoutMs,
          updatedAt: monitor.updatedAt,
        })),
      protocol: probeProtocol,
    };
  }

  function locationStates(monitorId: string): LocationState[] | undefined {
    const monitor = monitors.find((each) => each.id === monitorId);
    if (!monitor?.locations) {
      return;
    }
    const results = held.get(monitorId);
    const freshFor = freshForMs(monitor);
    const now = io.now();
    return monitor.locations.map((location) => {
      const state = results?.get(location);
      const fresh =
        state !== undefined && isKnown(monitor, state, now, freshFor);
      return {
        location,
        name: location === mainLocation ? undefined : probeNames.get(location),
        responseMs: fresh ? state.responseMs : undefined,
        result: fresh ? state.result : undefined,
        startedAt: state?.startedAt,
      };
    });
  }

  function start(monitor: Monitor, now: number, failed?: Heartbeat): void {
    // The run takes the window as it stands before afterCheck opens the next one.
    const run = runOf(monitor, now, failed);
    if (!(run && schedule)) {
      return;
    }
    schedule = afterCheck(
      schedule,
      monitor.id,
      now,
      timeZone,
      failed && failed.arrivedAt + 1
    );
    const flight = run
      .then((settled) => {
        if (!settled) {
          return;
        }
        const settlement = settle(monitor, settled);
        settling.add(settlement);
        return settlement.finally(() => settling.delete(settlement));
      })
      .catch((error: unknown) => {
        logError(
          `the check of the monitor ${monitor.id} could not be recorded: ${reasonOf(error)}`
        );
      })
      .finally(() => {
        inFlight.delete(monitor.id);
        flightStarts.delete(monitor.id);
      });
    inFlight.set(monitor.id, flight);
    flightStarts.set(monitor.id, now);
  }

  /** Evaluates now each heartbeat monitor whose heartbeats since its window opened say what its state does not: a down monitor whose latest heartbeat says the job ran, and a monitor that is not down that heard any failure, even one a heartbeat that says the job ran followed. Reads only what each kind needs: the latest heartbeats of the down ones, the latest failures of the others. */
  async function startHeard(now: number): Promise<void> {
    const heartbeatMonitors = [...(schedule?.values() ?? [])]
      .map(({ monitor }) => monitor)
      .filter((monitor) => monitor.config.type === "heartbeat")
      .map((monitor) => monitor.id);
    const down = heartbeatMonitors.filter((id) => states.get(id) === "down");
    const notDown = heartbeatMonitors.filter((id) => states.get(id) !== "down");
    let latest: ReadonlyMap<string, Heartbeat>;
    let failures: ReadonlyMap<string, Heartbeat>;
    try {
      [latest, failures] = await Promise.all([
        down.length > 0
          ? storage.heartbeats.latest(down, now)
          : new Map<string, Heartbeat>(),
        notDown.length > 0
          ? storage.heartbeats.lastFailures(notDown, now)
          : new Map<string, Heartbeat>(),
      ]);
    } catch (error) {
      logError(
        `the scheduler could not read the heartbeats: ${reasonOf(error)}`
      );
      return;
    }
    if (stopped || !schedule) {
      return;
    }
    // A down monitor recovers on a heartbeat that says the job ran; a failure while down waits for the window's end.
    const ran = new Map(
      [...latest]
        .filter(([, heartbeat]) => !heartbeat.failure)
        .map(([id, heartbeat]) => [id, heartbeat.arrivedAt])
    );
    const flying = new Set(inFlight.keys());
    // Both lists are read before any evaluation starts, which moves the schedule.
    const recovered = arrivedWhileDown(schedule, states, ran, flying);
    const failed = failedWhileUp(
      schedule,
      states,
      new Map(
        [...failures].map(([id, heartbeat]) => [id, heartbeat.arrivedAt])
      ),
      flying
    );
    for (const monitor of recovered) {
      start(monitor, now);
    }
    for (const monitor of failed) {
      start(monitor, now, failures.get(monitor.id));
    }
  }

  /** The tick's reads: the counter, the monitors when the operator moved it, the states once. Answers whether checks may start. */
  async function ready(now: number): Promise<boolean> {
    let counter: number;
    try {
      counter = await storage.changeCounter();
    } catch (error) {
      logError(
        `the scheduler could not read the change counter: ${reasonOf(error)}`
      );
      return false;
    }
    if (
      (schedule === undefined || counter !== known) &&
      (await readMonitors(now))
    ) {
      known = counter;
    }
    if (!statesSeeded) {
      // No check starts before the states are known, or a restart could repeat a degraded event.
      statesSeeded = await seedStates();
    }
    return statesSeeded && schedule !== undefined && !stopped;
  }

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }
    const now = io.now();
    lastTickAt = now;
    bootAt ??= now;
    // Notifications go out whether or not the monitors could be read.
    queue.run(now);
    if (!((await ready(now)) && schedule)) {
      return;
    }
    // Before the checks start, so a check settling from here on meets the windows as they stand.
    await maintenance.run(now);
    if (requested.size > 0) {
      // Read after the monitors, so a paused or deleted one is no longer on the schedule and is dropped.
      schedule = bringForward(schedule, requested, now);
      requested.clear();
    }
    // Before the due windows, so a failure heard inside one is evaluated as itself, with its message, and not lost to a later heartbeat that says the job ran; what it starts is in flight, and the due loop leaves it.
    await startHeard(now);
    // The schedule as startHeard left it: its evaluations opened their next windows.
    for (const monitor of dueMonitors(
      schedule,
      new Set(inFlight.keys()),
      now
    )) {
      start(monitor, now);
    }
    if (monitorsRead) {
      operator.remind(now, monitors, (id) => states.get(id) === "down");
    }
    watchProbes(now);
    certificates.run(now, monitors);
    registrations.run(now, monitors);
    nightly.run(now, monitors, timeZone);
    refreshedAt ??= now;
    if (now - refreshedAt >= refreshPeriod) {
      refreshedAt = now;
      await bump();
    }
  }

  function watch(): void {
    const now = io.now();
    if (lastTickAt !== undefined && tickVerdict(lastTickAt, now) === "dead") {
      options.onStale?.(now - lastTickAt);
    }
  }

  /** A tick never rejects (every failure is a log line), so the chain of ticks and timers never ends on its own. */
  function tickThenLoop(): void {
    tick()
      .finally(loop)
      .catch(() => undefined);
  }

  function loop(): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      tickThenLoop();
    }, tickPeriod);
  }

  return {
    acknowledge: (outage) => operator.acknowledge(outage),
    assignmentsOf,
    locationStates,
    report,
    checkNow: (monitorId) => {
      const monitor = monitors.find((each) => each.id === monitorId);
      if (
        monitor?.locations &&
        !monitor.locations.includes(mainLocation) &&
        !verdictOf(monitor, heldOf(monitorId), io.now())
      ) {
        // Checked from probes alone and none answering: a run would write nothing.
        return { answer: "unknown", from: io.now() };
      }
      const startedAt = flightStarts.get(monitorId);
      if (startedAt !== undefined) {
        return { answer: "running", from: startedAt };
      }
      requested.add(monitorId);
      // The tick that brings it forward starts it after this, whatever time that tick read.
      return { answer: "queued", from: io.now() };
    },
    idle: async () => {
      // A settlement may bump after its check; wait for both.
      await Promise.all([
        ...inFlight.values(),
        certificates.idle(),
        registrations.idle(),
        maintenance.idle(),
        nightly.idle(),
        operator.idle(),
        subscribers.idle(),
        queue.idle(),
        telling,
      ]);
      await bumps;
    },
    lastTickAt: () => lastTickAt,
    start: () => {
      stopped = false;
      watchdog = setInterval(watch, watchdogPeriod);
      tickThenLoop();
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      // The job ends at the next monitor, so a day it is sealing or purging lands whole; a certificate or registration read or a notification still out writes nothing.
      // A window's move under way lands whole, with its bump and its notifications.
      await maintenance.idle();
      await Promise.all([
        ...settling,
        nightly.idle(),
        operator.idle(),
        subscribers.idle(),
        certificates.flush(),
        registrations.flush(),
        queue.flush(),
        telling,
      ]);
      await bumps;
    },
    subscribers,
    tick,
    watch,
  };
}
