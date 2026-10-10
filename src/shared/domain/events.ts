/**
 * Which monitor events notify a monitor's channels (CONTEXT.md "Monitor
 * event"): the ones switched on that can happen for it. Down and
 * recovered can for every monitor; the degraded pair only with a
 * response-time threshold; certificate expiring only for an https monitor
 * with the expiry option on. The form greys what cannot happen, and the
 * scheduler sends nothing for it. No I/O.
 */
import type {
  MonitorEventKind,
  MonitorFields,
} from "@/shared/schemas/monitor.ts";

/** Whether the event can happen for the monitor as configured. */
export function eventApplies(
  kind: MonitorEventKind,
  monitor: Pick<MonitorFields, "config" | "degradedMs">
): boolean {
  switch (kind) {
    case "degraded_started":
    case "degraded_ended":
      return monitor.degradedMs !== undefined;
    case "certificate_expiring": {
      const { config } = monitor;
      return (
        config.type === "http" &&
        config.tlsExpiryDays !== undefined &&
        config.url.toLowerCase().startsWith("https:")
      );
    }
    default:
      return true;
  }
}

/** Whether the monitor notifies its channels of the event: switched on, and able to happen. */
export function notifies(
  monitor: Pick<MonitorFields, "config" | "degradedMs" | "events">,
  kind: MonitorEventKind
): boolean {
  return monitor.events.includes(kind) && eventApplies(kind, monitor);
}
