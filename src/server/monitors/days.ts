/**
 * What a bar reads of each monitor (CONTEXT.md "Day bar"): its observed
 * time, its outages, the spans windows covered it and its response times,
 * by UTC day, from its daily rollups where a day is sealed and its checks
 * after. The component bars and the monitors list read it the same way.
 * Throws what the storage throws, except that a monitor's own days read a
 * record this version cannot read as none.
 */
import { gapLimitMs } from "@/server/checks/heartbeat.ts";
import { readClock } from "@/server/settings/clock.ts";
import { coveredSpans } from "@/server/status/maintenance.ts";
import {
  type BarDay,
  componentDays,
  dayDetails,
  type MonitorHistory,
  monitorObservedDays,
  type ResponseDay,
} from "@/server/status/uptime.ts";
import { ComponentShapeError } from "@/server/storage/components.ts";
import { MaintenanceShapeError } from "@/server/storage/maintenance.ts";
import { OutageShapeError } from "@/server/storage/outages.ts";
import type { Storage } from "@/server/storage/storage.ts";
import { utcDayStart } from "@/shared/domain/retention.ts";
import { bucketsOf } from "@/shared/domain/rollup.ts";
import {
  coverageOf,
  displayedUptime,
  type Span,
} from "@/shared/domain/uptime.ts";
import type { Check } from "@/shared/schemas/check.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { OverviewDay } from "@/shared/schemas/overview.ts";
import type { Rollup } from "@/shared/schemas/rollup.ts";

const dayMs = 86_400_000;

/** One monitor's history and response times for a bar. */
export interface MonitorDays {
  readonly history: MonitorHistory;
  /** Response times by UTC day start. */
  readonly response: ReadonlyMap<number, ResponseDay>;
}

/** Each monitor's days from `from`, a UTC day start, to `now`, by monitor id. */
export async function readMonitorHistories(
  storage: Pick<Storage, "checks" | "outages" | "settings">,
  monitors: readonly Monitor[],
  options: {
    /** The spans windows covered each monitor (`coveredSpans`), by monitor id. */
    readonly covered: ReadonlyMap<string, readonly Span[]>;
    readonly from: number;
    readonly now: number;
  }
): Promise<Map<string, MonitorDays>> {
  const { covered, from, now } = options;
  const ids = monitors.map((monitor) => monitor.id);
  // Every monitor in one read of each kind: a remote database charges a round trip per read.
  const [{ timeZone }, unsealed, rollups, outages] = await Promise.all([
    readClock(storage),
    storage.checks.unsealed(utcDayStart(now)),
    storage.checks.rollupsOf(ids, "day", from, now),
    storage.outages.since(ids, from),
  ]);
  // A closed day no pass could seal stays in the head; its monitor's checks are read from there on.
  const firstUnsealed = new Map<string, number>();
  for (const each of unsealed) {
    firstUnsealed.set(
      each.monitorId,
      Math.min(firstUnsealed.get(each.monitorId) ?? each.day, each.day)
    );
  }
  const limits = new Map<string, number>();
  const coverageFroms = new Map<string, number>();
  for (const monitor of monitors) {
    const lastSealed = rollups.get(monitor.id)?.at(-1)?.at;
    limits.set(monitor.id, gapLimitMs(monitor, now, timeZone));
    // The checks take over the day after the last sealed one, or at a closed day left unsealed; a check just before covers its start.
    coverageFroms.set(
      monitor.id,
      Math.max(
        from,
        Math.min(
          lastSealed === undefined ? from : lastSealed + dayMs,
          firstUnsealed.get(monitor.id) ?? Number.POSITIVE_INFINITY
        )
      )
    );
  }
  const checks = await storage.checks.ranges(
    new Map(
      [...coverageFroms].map(([id, at]) => [id, at - (limits.get(id) ?? 0)])
    ),
    now
  );
  const read = new Map<string, MonitorDays>();
  for (const monitor of monitors) {
    const limit = limits.get(monitor.id) ?? 0;
    const coverageFrom = coverageFroms.get(monitor.id) ?? from;
    const days = rollups.get(monitor.id) ?? [];
    const own = checks.get(monitor.id) ?? [];
    const excluded = covered.get(monitor.id) ?? [];
    read.set(monitor.id, {
      history: {
        covered: excluded,
        observed: monitorObservedDays({
          coverage: coverageOf(
            own.map((check) => check.startedAt),
            limit
          ),
          coverageFrom,
          days,
          excluded,
          from,
          gapLimitMs: limit,
          now,
        }),
        outages: outages.get(monitor.id) ?? [],
      },
      response: responseOf(days, own, coverageFrom, now),
    });
  }
  return read;
}

/** A monitor's mean response time by UTC day start: from its daily rollups before `coverageFrom`, from its checks after. */
function responseOf(
  days: readonly Rollup[],
  checks: readonly Check[],
  coverageFrom: number,
  now: number
): Map<number, ResponseDay> {
  const response = new Map<number, ResponseDay>();
  for (const each of days) {
    if (each.at < coverageFrom && each.averageMs !== undefined) {
      response.set(each.at, {
        averageMs: each.averageMs,
        timed: each.checks - each.failed,
      });
    }
  }
  const tail = bucketsOf({
    bucketMs: dayMs,
    checks,
    from: coverageFrom,
    rollups: [],
    to: now,
  });
  for (const each of tail) {
    if (each.averageMs !== undefined) {
      response.set(each.at, {
        averageMs: each.averageMs,
        timed: each.checks - each.down,
      });
    }
  }
  return response;
}

type DaysStorage = Pick<
  Storage,
  "checks" | "components" | "maintenance" | "outages" | "settings"
>;

/** Each monitor's own days over the last `days` UTC days, today included, by monitor id: its outages over its observed time, a window's time out of both, and the windows that covered it named. The bars are a view on the side, so a record this version cannot read leaves every monitor with none; any other failure stands. */
export function readMonitorDays(
  storage: DaysStorage,
  monitors: readonly Monitor[],
  options: { readonly days: number; readonly now: number }
): Promise<Map<string, BarDay[]>> {
  return readDays(storage, monitors, options).catch((error: unknown) => {
    if (
      error instanceof MaintenanceShapeError ||
      error instanceof ComponentShapeError ||
      error instanceof OutageShapeError
    ) {
      return new Map<string, BarDay[]>();
    }
    throw error;
  });
}

async function readDays(
  storage: DaysStorage,
  monitors: readonly Monitor[],
  options: { readonly days: number; readonly now: number }
): Promise<Map<string, BarDay[]>> {
  const { now } = options;
  const from = utcDayStart(now) - (options.days - 1) * dayMs;
  const [windows, links] = await Promise.all([
    storage.maintenance.since(from),
    storage.components.list(),
  ]);
  const read = await readMonitorHistories(storage, monitors, {
    covered: coveredSpans(windows, links, now),
    from,
    now,
  });
  return new Map(
    monitors.map((monitor) => {
      const own = read.get(monitor.id);
      // A window covers a monitor through a component linked to it, as its reach reads the links.
      const through = new Set(
        links
          .filter((each) => each.monitorIds.includes(monitor.id))
          .map((each) => each.id)
      );
      const maintenance = windows
        .filter((each) => each.componentIds.some((id) => through.has(id)))
        .map(({ endsAt, id, startsAt, title }) => ({
          endedAt: endsAt,
          id,
          startedAt: startsAt,
          title,
        }));
      const details = dayDetails({
        from,
        notices: { incidents: [], maintenance },
        now,
        response: own ? [own.response] : [],
      });
      const days = componentDays({
        createdAt: monitor.createdAt,
        from,
        incidents: [],
        maintenance: [],
        monitors: own ? [own.history] : [],
        now,
      });
      // The two lay out the same days, so each finds its detail.
      return [
        monitor.id,
        days.flatMap((each, index) => {
          const detail = details[index];
          return detail ? [{ ...each, ...detail }] : [];
        }),
      ];
    })
  );
}

/** A bar day as a document carries it: its date, its parts, its uptime and its notices. */
export function dayView(day: BarDay): OverviewDay {
  return {
    date: new Date(day.day).toISOString().slice(0, 10),
    downtimeMs: day.downtimeMs,
    incidents: [...day.incidents],
    maintenance: [...day.maintenance],
    observedMs: day.observedMs,
    responseMs: day.responseMs ?? null,
    uptime: displayedUptime(day) ?? null,
  };
}
