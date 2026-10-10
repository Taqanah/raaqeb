/**
 * Test support for the components and pages modules: an open storage on a
 * scratch database with its own clock and the public address stored, a
 * monitor to link, and checks to record. Not product code.
 */

import { publicAddress } from "@/server/settings/address.ts";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import {
  type DatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import type { CheckResult } from "@/shared/schemas/check.ts";
import {
  type Monitor,
  type MonitorInput,
  monitorEventKinds,
} from "@/shared/schemas/monitor.ts";
import { reasons } from "@/shared/schemas/reason.ts";

/** Publishes a stored page as the editor's switch does, its fields and layout kept, and moves the change counter. */
export async function publish(
  storage: Pick<Storage, "bump" | "pages">,
  id: string
): Promise<void> {
  const page = await storage.pages.find(id);
  if (!page) {
    throw new Error(`no status page ${id} to publish`);
  }
  await storage.pages.save(
    id,
    { ...page, published: true },
    await storage.pages.layout(id)
  );
  await storage.bump();
}

/** The public address the scratch install stores. */
export const testAddress = "https://status.raaqeb.test";

/** A UTC midnight, the first day of the scratch install's history. */
export const d0 = Date.UTC(2026, 8, 1);
export const day = 86_400_000;
export const hour = 3_600_000;
export const minute = 60_000;

export interface PagesScratch {
  /** Moves the storage's clock, which stamps every row it writes. */
  readonly at: (time: number) => void;
  readonly cleanup: () => Promise<void>;
  readonly location: DatabaseLocation;
  readonly storage: Storage;
}

export async function scratchPages(start = d0): Promise<PagesScratch> {
  const scratch = await scratchDatabase();
  let time = start;
  const opened = await openStorage(scratch.location, { now: () => time });
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  await opened.storage.settings.set(publicAddress, testAddress);
  return {
    at: (next) => {
      time = next;
    },
    cleanup: async () => {
      await opened.storage.close();
      await scratch.cleanup();
    },
    location: scratch.location,
    storage: opened.storage,
  };
}

export const site: MonitorInput = {
  channels: [],
  config: {
    assertions: [{ codes: ["2xx"], kind: "status" }],
    captureMode: "off",
    followRedirects: true,
    ignoreTlsErrors: false,
    method: "GET",
    type: "http",
    url: "https://example.test/",
  },
  events: [...monitorEventKinds],
  intervalMs: 60_000,
  name: "Site",
  retries: 0,
  tags: [],
  timeoutMs: 10_000,
};

/** Records one check a minute from `from` up to `to`, each with the result. */
export async function checksEveryMinute(
  storage: Storage,
  monitor: Monitor,
  from: number,
  to: number,
  result: CheckResult
): Promise<void> {
  for (let at = from; at < to; at += minute) {
    // biome-ignore lint/performance/noAwaitInLoops: the head table's rows go in one at a time, as the scheduler writes them
    await storage.checks.record({
      capture: undefined,
      check: {
        attempts: 1,
        bytes: 0,
        monitorId: monitor.id,
        reason: result === "down" ? reasons.timeout : reasons.ok,
        responseMs: result === "down" ? undefined : 120,
        result,
        startedAt: at,
        statusCode: result === "down" ? undefined : 200,
      },
      detail: undefined,
    });
  }
}

/** Whether the text holds a character XML 1.0 refuses outright: a C0 control but tab, line feed and carriage return, or U+FFFE and U+FFFF. */
export function forbiddenInXml(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xff_fe ||
      code === 0xff_ff
    );
  });
}
