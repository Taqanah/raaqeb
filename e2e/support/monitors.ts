/**
 * The nine monitors the English install is seeded with (e2e/support/serve-en.ts),
 * also seeded into an install of a test's own that measures the list
 * where no other spec's monitors, groups or tags can reach it. Not product code.
 */
import type { Storage } from "@/server/storage/storage.ts";
import type { MonitorInput } from "@/shared/schemas/monitor.ts";
import { monitorEventKinds } from "@/shared/schemas/monitor.ts";

type Config = MonitorInput["config"];

const http = (url: string): Config => ({
  assertions: [{ codes: ["2xx"], kind: "status" }],
  captureMode: "off",
  followRedirects: true,
  ignoreTlsErrors: false,
  method: "GET",
  type: "http",
  url,
});
const tcp = (tcpHost: string, tcpPort: number): Config => ({
  host: tcpHost,
  port: tcpPort,
  type: "tcp",
});
// Every target is a loopback port nothing listens on, and the DNS resolver
// too, so the scheduler's checks never leave the machine.
const dns = (name: string): Config => ({
  name,
  recordType: "A",
  resolver: "127.0.0.1:1",
  type: "dns",
});
const beat: Config = {
  schedule: { everyMs: 3_600_000, kind: "every" },
  type: "heartbeat",
};
const monitor = (
  name: string,
  config: Config,
  tags: string[],
  group?: string
): MonitorInput => ({
  channels: [],
  events: [...monitorEventKinds],
  config,
  group,
  intervalMs: 60_000,
  name,
  retries: 2,
  tags,
  timeoutMs: 10_000,
});

// Eight monitors, so the list's 800 px target can be measured,
// plus a ninth the monitors spec deletes; its name sorts last under "en".
const seeded: readonly MonitorInput[] = [
  monitor("Website", http("http://127.0.0.1:1/"), ["public"], "Production"),
  monitor(
    "API",
    http("http://127.0.0.1:1/health"),
    ["public", "critical"],
    "Production"
  ),
  monitor("Mail", tcp("127.0.0.1", 1), ["internal"], "Production"),
  monitor("DNS", dns("example.com"), []),
  monitor("Staging site", http("http://127.0.0.1:2/"), ["internal"], "Staging"),
  monitor("Database", tcp("127.0.0.1", 2), ["internal", "critical"], "Staging"),
  monitor("Nightly backup", beat, [], "Jobs"),
  monitor("Docs", http("http://127.0.0.1:3/"), ["public"]),
  monitor("Zz deletable", http("http://127.0.0.1:4/"), []),
];

/** Creates the nine monitors, a few milliseconds apart. */
export async function seedMonitors(storage: Storage): Promise<void> {
  for (const input of seeded) {
    // biome-ignore lint/performance/noAwaitInLoops: one at a time, a few milliseconds apart, so the creation times are distinct and the newest sort is testable
    await storage.monitors.create(input);
    await Bun.sleep(3);
  }
}
