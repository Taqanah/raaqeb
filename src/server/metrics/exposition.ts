/**
 * The Prometheus text exposition format (version 0.0.4) of the install's
 * monitors: pure, one gauge family per fact, a family with no sample left
 * out. Names follow Prometheus conventions with the `raaqeb_` prefix, base
 * units (seconds, ratios) and a unit suffix; labels are the monitor, its id (names repeat), its
 * group (empty without one) and its check type.
 */
import type { CheckResult } from "@/shared/schemas/check.ts";

export const contentType = "text/plain; version=0.0.4; charset=utf-8";

/** What one monitor contributes to a scrape. */
export interface MonitorSample {
  /** When the certificate expires, UTC milliseconds. */
  readonly certificateExpiresAt: number | undefined;
  /** When the latest check started, UTC milliseconds. */
  readonly checkedAt: number | undefined;
  readonly checkType: string;
  readonly group: string;
  readonly monitor: string;
  /** The monitor's id: names are not unique, so it is what keeps two monitors' series apart. */
  readonly monitorId: string;
  readonly paused: boolean;
  /** The latest check's response time. */
  readonly responseMs: number | undefined;
  /** The latest check's result; nothing before the first check. */
  readonly state: CheckResult | undefined;
}

const backslash = /\\/g;
const quote = /"/g;
const lineBreak = /\n/g;

/** A label value: backslash, double quote and line feed escaped. */
function labelValue(value: string): string {
  return value
    .replace(backslash, "\\\\")
    .replace(quote, '\\"')
    .replace(lineBreak, "\\n");
}

interface Family {
  readonly help: string;
  readonly name: string;
  /** The sample's value, or nothing for a monitor without the fact. */
  readonly samples: (monitor: MonitorSample) => string | undefined;
}

function labelsOf(monitor: MonitorSample): string {
  return `monitor="${labelValue(monitor.monitor)}",monitor_id="${labelValue(monitor.monitorId)}",group="${labelValue(monitor.group)}",check_type="${labelValue(monitor.checkType)}"`;
}

/** A paused monitor has no state: its latest check is from before it stopped. */
function stateOf(monitor: MonitorSample): CheckResult | undefined {
  return monitor.paused ? undefined : monitor.state;
}

const families: readonly Family[] = [
  {
    help: "Whether the monitor's latest check was up or degraded (1) or down (0). Absent while paused or before the first check.",
    name: "raaqeb_monitor_up",
    samples: (monitor) => {
      const state = stateOf(monitor);
      return state === undefined ? undefined : `${state === "down" ? 0 : 1}`;
    },
  },
  {
    help: "Whether the monitor's latest check succeeded but was slower than its degraded threshold (1) or not (0). Absent while paused or before the first check.",
    name: "raaqeb_monitor_degraded",
    samples: (monitor) => {
      const state = stateOf(monitor);
      return state === undefined
        ? undefined
        : `${state === "degraded" ? 1 : 0}`;
    },
  },
  {
    help: "Whether the monitor is paused (1) or runs its checks (0).",
    name: "raaqeb_monitor_paused",
    samples: (monitor) => (monitor.paused ? "1" : "0"),
  },
  {
    help: "The latest check's response time in seconds. Absent while paused, or when the check had none.",
    name: "raaqeb_monitor_response_seconds",
    samples: (monitor) =>
      monitor.paused || monitor.responseMs === undefined
        ? undefined
        : `${monitor.responseMs / 1000}`,
  },
  {
    help: "When the monitor's latest check started, in seconds since the Unix epoch.",
    name: "raaqeb_monitor_last_check_timestamp_seconds",
    samples: (monitor) =>
      monitor.checkedAt === undefined
        ? undefined
        : `${monitor.checkedAt / 1000}`,
  },
  {
    help: "When the monitor's TLS certificate expires, in seconds since the Unix epoch.",
    name: "raaqeb_certificate_expiry_timestamp_seconds",
    samples: (monitor) =>
      monitor.certificateExpiresAt === undefined
        ? undefined
        : `${monitor.certificateExpiresAt / 1000}`,
  },
];

export function exposition(
  version: string,
  monitors: readonly MonitorSample[]
): string {
  const out: string[] = [];
  const labels = monitors.map(labelsOf);
  for (const family of families) {
    const lines = monitors.flatMap((monitor, index) => {
      const value = family.samples(monitor);
      return value === undefined
        ? []
        : [`${family.name}{${labels[index]}} ${value}`];
    });
    if (lines.length > 0) {
      out.push(
        `# HELP ${family.name} ${family.help}`,
        `# TYPE ${family.name} gauge`,
        ...lines
      );
    }
  }
  out.push(
    "# HELP raaqeb_build_info The running build, as a constant 1 labelled with its version.",
    "# TYPE raaqeb_build_info gauge",
    `raaqeb_build_info{version="${labelValue(version)}"} 1`
  );
  return `${out.join("\n")}\n`;
}
