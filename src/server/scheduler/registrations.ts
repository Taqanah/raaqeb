/**
 * The registration pass (CONTEXT.md "Domain registration"): on the
 * scheduler's tick, at most once a minute and never twice at once, it reads
 * the registration of every unpaused HTTP, TCP and DNS monitor with the
 * domain expiry option on that has none yet or was last read on an earlier
 * UTC day, one read at a time, beside the checks and never in their way, and
 * stores what it read. The reader keeps each name's answer for the day, so
 * monitors under one domain ask its registry once. A read that failed leaves
 * the registration as it was and is tried again an hour later; the attempts
 * live in memory, so a restart tries at once. Once the scheduler stops, the
 * pass ends at the next monitor and a read that ends later writes nothing.
 * After the reads, each registration whose warning fell due is raised and
 * then remembered on the record, so a warning whose notification could not
 * be queued is raised again at the next pass. A monitor with the event off
 * or no channel selected has no warning due at all, so switching it on or
 * selecting a channel later still sends it.
 */

import {
  type RegistrationReader,
  registrationReadDue,
} from "@/server/checks/registration.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import type { RegistrationsRepository } from "@/server/storage/registrations.ts";
import {
  registrationHost,
  registrationWarningDue,
} from "@/shared/domain/registrations.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { DomainRegistration } from "@/shared/schemas/registration.ts";
import type { MonitorEvent } from "./schedule.ts";

/** What the pass needs of storage; the storage module satisfies it. */
export interface RegistrationPassStorage {
  readonly registrations: Pick<
    RegistrationsRepository,
    "list" | "replace" | "warned"
  >;
}

/** What the pass needs of a monitor. */
export type RegistrationMonitor = Pick<
  Monitor,
  "channels" | "config" | "events" | "id" | "paused"
>;

/** The pass runs this often; a read is due once a day, so a minute's granularity is plenty. */
export const registrationPeriodMs = 60_000;

/** A read that failed is tried again this long after, so a registry that is down costs one request an hour, not one a pass. */
export const registrationRetryIntervalMs = 60 * 60 * 1000;

export interface RegistrationPass {
  /** Waits for the write under way, if any; once the scheduler stops, the last thing the pass does to storage. Never waits for a read. */
  flush: () => Promise<void>;
  /** Resolves once no pass is under way. */
  idle: () => Promise<void>;
  /** On the tick: starts a pass over the monitors as the tick read them when none is under way and the last started a period ago. Never waits for it and never throws; a pass that fails is logged. */
  run: (now: number, monitors: readonly RegistrationMonitor[]) => void;
}

export interface RegistrationPassOptions {
  /** Whether a maintenance window in progress covers the monitor now: its warning is neither raised nor remembered, so it goes once the window ends; absent, none is covered. */
  readonly covers?: (monitorId: string) => boolean;
  /** Whether the scheduler has stopped; the pass ends at the next monitor and writes nothing more. */
  readonly isStopped: () => boolean;
  /** Called with each warning that falls due, before the record remembers it was sent, so a warning is sent at least once. */
  readonly onExpiring?: (
    event: Extract<MonitorEvent, { kind: "domain_expiring" }>
  ) => Promise<void>;
  /** How often a pass starts. */
  readonly periodMs?: number;
}

type Expiring = Extract<MonitorEvent, { kind: "domain_expiring" }>;

export function createRegistrationPass(
  storage: RegistrationPassStorage,
  reader: RegistrationReader,
  options: RegistrationPassOptions
): RegistrationPass {
  const period = options.periodMs ?? registrationPeriodMs;
  let startedAt: number | undefined;
  let pass: Promise<void> | undefined;
  let write: Promise<void> | undefined;
  /** Each monitor whose last read failed, and when. */
  const attempts = new Map<string, number>();

  /** Waits for one write, which flush can wait for too. */
  async function writing(work: Promise<unknown>): Promise<void> {
    write = work.then(() => undefined);
    try {
      await write;
    } finally {
      write = undefined;
    }
  }

  async function readDue(
    now: number,
    monitors: readonly RegistrationMonitor[]
  ): Promise<void> {
    const records = await storage.registrations.list();
    const seen = new Map(records.map((record) => [record.monitorId, record]));
    const due = monitors.flatMap((monitor) => {
      const host = registrationHost(monitor.config);
      const triedAt = attempts.get(monitor.id);
      return !monitor.paused &&
        host !== undefined &&
        registrationReadDue(seen.get(monitor.id), now) &&
        !(triedAt !== undefined && triedAt + registrationRetryIntervalMs > now)
        ? [{ host, monitor }]
        : [];
    });
    for (const { host, monitor } of due) {
      if (options.isStopped()) {
        return;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one read at a time, and the reader asks each name once a day
      const read = await reader.read(host).catch(() => undefined);
      if (!read) {
        attempts.set(monitor.id, now);
        continue;
      }
      // A read that ends after stop writes nothing to a storage about to close.
      if (options.isStopped()) {
        return;
      }
      attempts.delete(monitor.id);
      const record = { ...read, monitorId: monitor.id, readAt: now };
      try {
        await writing(storage.registrations.replace(record));
      } catch (error) {
        // One monitor's write (one deleted since the tick read it) skips that monitor, never the pass.
        logError(
          `the registration of the monitor ${monitor.id} could not be stored: ${reasonOf(error)}`
        );
        continue;
      }
      // The repository keeps the warning sent while the expiry date is the same; so does this pass's copy.
      const previous = seen.get(monitor.id);
      seen.set(monitor.id, {
        ...record,
        warned:
          previous?.warned === true &&
          read.expiresAt !== undefined &&
          previous.expiresAt === read.expiresAt,
      });
    }
    await warnDue(now, monitors, seen);
  }

  /** Raises each warning that fell due, then remembers it on the record, so a warning whose notification failed is raised again at the next pass. */
  async function warnDue(
    now: number,
    monitors: readonly RegistrationMonitor[],
    seen: ReadonlyMap<string, DomainRegistration>
  ): Promise<void> {
    const { onExpiring } = options;
    if (!onExpiring) {
      return;
    }
    for (const monitor of monitors) {
      const record = seen.get(monitor.id);
      const event = record && warningOf(monitor, record, now);
      // A covered monitor's warning is neither raised nor remembered, so it goes once the window ends.
      if (!event || options.covers?.(monitor.id) || options.isStopped()) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a warning is rare, and each is remembered before the next
      if ((await raised(onExpiring, event)) && !options.isStopped()) {
        await writing(
          storage.registrations.warned(monitor.id, event.expiresAt)
        );
      }
    }
  }

  return {
    flush: async () => {
      // The pass logs a write that failed; flush only waits for it.
      await write?.catch(() => undefined);
    },
    idle: async () => {
      await pass;
    },
    run: (now, monitors) => {
      if (
        pass !== undefined ||
        (startedAt !== undefined && now - startedAt < period)
      ) {
        return;
      }
      startedAt = now;
      pass = readDue(now, monitors)
        .catch((error: unknown) => {
          logError(`the registration pass failed: ${reasonOf(error)}`);
        })
        .finally(() => {
          pass = undefined;
        });
    },
  };
}

/** Hands the warning to the scheduler; answers whether its notification is queued, and logs when it is not. */
async function raised(
  onExpiring: (event: Expiring) => Promise<void>,
  event: Expiring
): Promise<boolean> {
  try {
    await onExpiring(event);
    return true;
  } catch (error) {
    logError(
      `the domain expiring warning of the monitor ${event.monitorId} is raised again at the next pass: ${reasonOf(error)}`
    );
    return false;
  }
}

/** The warning due for an unpaused monitor with the option and the event on and a channel selected; nothing for any other. */
function warningOf(
  monitor: RegistrationMonitor,
  record: DomainRegistration,
  now: number
): Expiring | undefined {
  // A warning switched off, or with no channel to take it, is neither raised nor remembered, so switching it on or selecting a channel later still sends it.
  if (
    monitor.paused ||
    !monitor.events.includes("domain_expiring") ||
    monitor.channels.length === 0 ||
    registrationHost(monitor.config) === undefined ||
    record.domain === undefined ||
    record.expiresAt === undefined ||
    !registrationWarningDue(record, now)
  ) {
    return;
  }
  return {
    at: now,
    domain: record.domain,
    expiresAt: record.expiresAt,
    kind: "domain_expiring",
    monitorId: monitor.id,
  };
}
