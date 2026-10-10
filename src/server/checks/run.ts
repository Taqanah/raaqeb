/**
 * One check of any monitor (CONTEXT.md "Check", "Check type"): the dispatch
 * on the check type onto the HTTP, TCP, DNS, database and Docker checks over the one live I/O
 * bundle. The scheduler runs due monitors through it, and the monitor form's
 * "test now" runs one without recording it. A heartbeat monitor
 * has no check to run here: the scheduler evaluates its window (heartbeat.ts).
 */
import type { CheckOutcome } from "@/shared/schemas/check.ts";
import type { Credentials } from "@/shared/schemas/credentials.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import { runDatabaseCheck } from "./database.ts";
import { runDnsCheck } from "./dns.ts";
import { runDockerCheck } from "./docker.ts";
import { runHttpCheck } from "./http.ts";
import type { LiveIo } from "./io.ts";
import { runTcpCheck } from "./tcp.ts";

/** What one check needs of a monitor: its schedule's limits, its config, and the credentials an HTTP request sends or a database check connects with. */
export type CheckedMonitor = Pick<
  Monitor,
  "id" | "timeoutMs" | "retries" | "degradedMs" | "config"
> & { readonly credentials?: Credentials };

/** Runs one check of the monitor now, or answers nothing for a heartbeat monitor. */
export function runCheck(
  monitor: CheckedMonitor,
  io: LiveIo
): Promise<CheckOutcome> | undefined {
  const { config } = monitor;
  switch (config.type) {
    case "http":
      return runHttpCheck({ ...monitor, config }, io);
    case "tcp":
      return runTcpCheck({ ...monitor, config }, io);
    case "dns":
      return runDnsCheck({ ...monitor, config }, io);
    case "postgres":
    case "mysql":
    case "redis":
      return runDatabaseCheck({ ...monitor, config }, io);
    case "docker":
      return runDockerCheck({ ...monitor, config }, io);
    default:
      return;
  }
}
