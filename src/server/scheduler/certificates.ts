/**
 * The certificate reader's pass (CONTEXT.md "Certificate record"
 * TLS, 2.3): on the scheduler's tick, at most once a minute and never twice
 * at once, it reads the due certificate of every unpaused HTTPS monitor with
 * the expiry option on, one connection at a time, beside the checks and
 * never in their way, and stores what it read. A failed read leaves the
 * record as it was and is tried again an hour later, not on the next pass;
 * the attempts live in memory, so a restart tries at once. Once the
 * scheduler stops, the pass ends at the next monitor and a read that ends
 * later writes nothing. What is due and how one certificate is read are the
 * reader's rules in `checks/certificate.ts`. After the reads, each record's
 * certificate warning that fell due (at the monitor's threshold,
 * then at 1 day) is raised and then remembered on the record, so a warning
 * whose notification could not be queued is raised again at the next pass.
 * A monitor with no channel selected has no warning due at all, so a channel
 * selected later still gets it.
 */

import {
  certificateReadDue,
  certificateTarget,
  readCertificate,
  type TlsIo,
} from "@/server/checks/certificate.ts";
import { error as logError, reasonOf } from "@/server/log.ts";
import type { CertificatesRepository } from "@/server/storage/certificates.ts";
import { certificateWarningDue } from "@/shared/domain/certificates.ts";
import type {
  CertificateRecord,
  CertificateWarning,
} from "@/shared/schemas/certificate.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { MonitorEvent } from "./schedule.ts";

/** What the pass needs of storage; the storage module satisfies it. */
export interface CertificatePassStorage {
  readonly certificates: Pick<
    CertificatesRepository,
    "list" | "replace" | "warned"
  >;
}

/** What the pass needs of a monitor. */
export type CertificateMonitor = Pick<
  Monitor,
  "channels" | "config" | "events" | "id" | "paused"
>;

/** The pass runs this often; a read is due every 12 hours, so a minute's granularity is plenty. */
export const certificatePeriodMs = 60_000;

/** A read that failed is tried again this long after, so a host that is down costs one connection an hour, not one a pass. */
export const certificateRetryIntervalMs = 60 * 60 * 1000;

export interface CertificatePass {
  /** Waits for the write under way, if any; once the scheduler stops, the last thing the pass does to storage. Never waits for a read. */
  flush: () => Promise<void>;
  /** Resolves once no pass is under way. */
  idle: () => Promise<void>;
  /** On the tick: starts a pass over the monitors as the tick read them when none is under way and the last started a period ago. Never waits for it and never throws; a pass that fails is logged. */
  run: (now: number, monitors: readonly CertificateMonitor[]) => void;
}

export interface CertificatePassOptions {
  /** Whether a maintenance window in progress covers the monitor now: its warning is neither raised nor remembered, so it goes once the window ends; absent, none is covered. */
  readonly covers?: (monitorId: string) => boolean;
  /** Whether the scheduler has stopped; the pass ends at the next monitor and writes nothing more. */
  readonly isStopped: () => boolean;
  /** Called with each certificate warning that falls due, before the record remembers it was sent, so a warning is sent at least once. */
  readonly onExpiring?: (
    event: Extract<MonitorEvent, { kind: "certificate_expiring" }>
  ) => Promise<void>;
  /** How often a pass starts. */
  readonly periodMs?: number;
}

export function createCertificatePass(
  storage: CertificatePassStorage,
  io: TlsIo,
  options: CertificatePassOptions
): CertificatePass {
  const period = options.periodMs ?? certificatePeriodMs;
  let startedAt: number | undefined;
  let pass: Promise<void> | undefined;
  let write: Promise<void> | undefined;
  /** Each monitor whose last read failed, and when. */
  const attempts = new Map<string, number>();

  async function readDue(
    now: number,
    monitors: readonly CertificateMonitor[]
  ): Promise<void> {
    const records = await storage.certificates.list();
    const seen = new Map(records.map((record) => [record.monitorId, record]));
    const due = monitors.filter(
      (monitor) =>
        !monitor.paused &&
        certificateTarget(monitor) !== undefined &&
        certificateReadDue(seen.get(monitor.id), now) &&
        !triedLately(attempts.get(monitor.id), now)
    );
    for (const monitor of due) {
      if (options.isStopped()) {
        return;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one connection at a time, so a pass never opens every socket at once
      const record = await readCertificate(monitor, io);
      if (!record) {
        attempts.set(monitor.id, io.now());
        continue;
      }
      // A read that ends after stop writes nothing to a storage about to close.
      if (options.isStopped()) {
        return;
      }
      attempts.delete(monitor.id);
      write = storage.certificates.replace(record);
      try {
        await write;
      } finally {
        write = undefined;
      }
      // The repository keeps the warning sent while the fingerprint is the same; so does this pass's copy.
      const previous = seen.get(monitor.id);
      seen.set(
        monitor.id,
        previous?.fingerprint === record.fingerprint && previous.warned
          ? { ...record, warned: previous.warned }
          : record
      );
    }
    await warnDue(now, monitors, seen);
  }

  /** Raises each certificate warning that fell due, then remembers it on the record, so a warning whose notification failed is raised again at the next pass. */
  async function warnDue(
    now: number,
    monitors: readonly CertificateMonitor[],
    seen: ReadonlyMap<string, CertificateRecord>
  ): Promise<void> {
    const { onExpiring } = options;
    if (!onExpiring) {
      return;
    }
    for (const monitor of monitors) {
      const record = seen.get(monitor.id);
      // A covered monitor's warning is neither raised nor remembered, so it goes once the window ends.
      const warning =
        record && !options.covers?.(monitor.id)
          ? warningOf(monitor, record, now)
          : undefined;
      if (!(record && warning) || options.isStopped()) {
        continue;
      }
      const event = {
        at: now,
        kind: "certificate_expiring",
        monitorId: monitor.id,
        validTo: record.validTo,
        warning,
      } as const;
      // biome-ignore lint/performance/noAwaitInLoops: a warning is rare, and each is remembered before the next
      if ((await raised(onExpiring, event)) && !options.isStopped()) {
        write = storage.certificates
          .warned(monitor.id, record.fingerprint, warning)
          .then(() => undefined);
        try {
          await write;
        } finally {
          write = undefined;
        }
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
          logError(`the certificate pass failed: ${reasonOf(error)}`);
        })
        .finally(() => {
          pass = undefined;
        });
    },
  };
}

/** Hands the warning to the scheduler; answers whether its notification is queued, and logs when it is not. */
async function raised(
  onExpiring: NonNullable<CertificatePassOptions["onExpiring"]>,
  event: Parameters<NonNullable<CertificatePassOptions["onExpiring"]>>[0]
): Promise<boolean> {
  try {
    await onExpiring(event);
    return true;
  } catch (error) {
    logError(
      `the certificate warning of the monitor ${event.monitorId} is raised again at the next pass: ${reasonOf(error)}`
    );
    return false;
  }
}

/** The warning due for an unpaused HTTPS monitor with the expiry option and the event on and a channel selected, at its own threshold; nothing for any other. */
function warningOf(
  monitor: CertificateMonitor,
  record: CertificateRecord,
  now: number
): CertificateWarning | undefined {
  const { config } = monitor;
  // A warning switched off, or with no channel to take it, is neither raised nor remembered, so switching it on or selecting a channel later still sends it.
  if (
    monitor.paused ||
    !monitor.events.includes("certificate_expiring") ||
    monitor.channels.length === 0 ||
    config.type !== "http" ||
    config.tlsExpiryDays === undefined ||
    certificateTarget(monitor) === undefined
  ) {
    return;
  }
  return certificateWarningDue(record, config.tlsExpiryDays, now);
}

function triedLately(triedAt: number | undefined, now: number): boolean {
  return triedAt !== undefined && triedAt + certificateRetryIntervalMs > now;
}
