/**
 * A component's status (CONTEXT.md "Derived status", "Component" rules 1 to 3). The derived status comes from the linked,
 * unpaused monitors: all down is a major outage, some down a partial
 * outage, none down but any degraded is degraded performance, otherwise
 * operational. With every linked monitor paused the last derived status
 * stands, which is the one the monitors paused last derive, since just
 * before that pause they were the unpaused ones.
 * Precedence: an active maintenance window shows under maintenance;
 * otherwise the worse of the incident-set status and the derived status;
 * an unlinked component with no incident keeps its hand-set status. The
 * group aggregate and the page level are `worstStatus` in shared/domain.
 * The summary's indicator is the page level mapped or an open incident's
 * impact, whichever is worse. Pure: no I/O; every
 * record is a parameter.
 */
import { latestStatuses } from "@/shared/domain/incidents.ts";
import { worstStatus } from "@/shared/domain/status.ts";
import type { CheckResult } from "@/shared/schemas/check.ts";
import type { Component } from "@/shared/schemas/component.ts";
import type { ImpactLevel, Incident } from "@/shared/schemas/incident.ts";
import type { Monitor } from "@/shared/schemas/monitor.ts";
import type { Outage } from "@/shared/schemas/outage.ts";
import type { HandSetLevel, StatusLevel } from "@/shared/schemas/status.ts";
import { type Indicator, indicators } from "@/shared/schemas/summary.ts";

/** A linked monitor as the derivation reads it. */
export interface LinkedMonitor {
  readonly paused: boolean;
  /** When it was paused; nothing while it runs. */
  readonly pausedAt: number | undefined;
  /** Its latest check's result; nothing before its first check. */
  readonly state: CheckResult | undefined;
}

/** A paused monitor's state once retention has taken its checks: down when its newest outage ended the moment it was paused, which is what pausing does to an open one; nothing otherwise, so a monitor paused while degraded reads as up. */
export function stateAtPause(
  pausedAt: number | undefined,
  newest: Pick<Outage, "endedAt"> | undefined
): CheckResult | undefined {
  return pausedAt !== undefined && newest?.endedAt === pausedAt
    ? "down"
    : undefined;
}

/** The derived status of a component's linked monitors; nothing for a component with none. */
export function derivedStatus(
  monitors: readonly LinkedMonitor[]
): StatusLevel | undefined {
  if (monitors.length === 0) {
    return;
  }
  const running = monitors.filter((monitor) => !monitor.paused);
  const judged = running.length > 0 ? running : pausedLast(monitors);
  const down = judged.filter((monitor) => monitor.state === "down").length;
  if (down === judged.length) {
    return "major_outage";
  }
  if (down > 0) {
    return "partial_outage";
  }
  return judged.some((monitor) => monitor.state === "degraded")
    ? "degraded_performance"
    : "operational";
}

/** The monitors paused at the latest pause time; one with no time counts as paused before any other. */
function pausedLast(monitors: readonly LinkedMonitor[]): LinkedMonitor[] {
  const at = (monitor: LinkedMonitor) =>
    monitor.pausedAt ?? Number.NEGATIVE_INFINITY;
  const latest = Math.max(...monitors.map(at));
  return monitors.filter((monitor) => at(monitor) === latest);
}

export interface StatusSources {
  /** The derived status; nothing for an unlinked component. */
  readonly derived: StatusLevel | undefined;
  readonly handSet: HandSetLevel;
  /** The status open incidents set on the component (`incidentStatuses`). */
  readonly incident: StatusLevel | undefined;
  /** A maintenance window affecting the component is in progress. */
  readonly maintenance: boolean;
}

/** The component's status by the precedence rule. */
export function componentStatus(sources: StatusSources): StatusLevel {
  if (sources.maintenance) {
    return "under_maintenance";
  }
  if (sources.derived === undefined) {
    return sources.incident ?? sources.handSet;
  }
  return worstStatus([sources.derived, sources.incident ?? "operational"]);
}

/** The status open incidents set on each component they affect, by component id: the worst of their latest updates'. A resolved incident sets none. */
export function incidentStatuses(
  incidents: readonly Incident[]
): Map<string, StatusLevel> {
  const statuses = new Map<string, StatusLevel>();
  for (const incident of incidents) {
    if (incident.resolvedAt !== undefined) {
      continue;
    }
    for (const { componentId, status } of latestStatuses(incident)) {
      const held = statuses.get(componentId);
      statuses.set(
        componentId,
        held === undefined ? status : worstStatus([held, status])
      );
    }
  }
  return statuses;
}

/** Every component's status now, by id, from the monitors, their latest checks' results, the open incidents' statuses and the windows in progress. */
export function componentStatuses(input: {
  readonly components: readonly Component[];
  /** What `incidentStatuses` answers for the open incidents. */
  readonly incidents: ReadonlyMap<string, StatusLevel>;
  /** The components under maintenance (`underMaintenance`). */
  readonly maintenance: ReadonlySet<string>;
  readonly monitors: readonly Monitor[];
  /** Each monitor's latest check's result, by monitor id. */
  readonly states: ReadonlyMap<string, CheckResult>;
}): Map<string, StatusLevel> {
  const monitors = new Map(input.monitors.map((each) => [each.id, each]));
  const statuses = new Map<string, StatusLevel>();
  for (const component of input.components) {
    const linked = component.monitorIds.flatMap((id) => {
      const monitor = monitors.get(id);
      return monitor
        ? [
            {
              paused: monitor.paused,
              pausedAt: monitor.pausedAt,
              state: input.states.get(id),
            },
          ]
        : [];
    });
    statuses.set(
      component.id,
      componentStatus({
        derived: derivedStatus(linked),
        handSet: component.status,
        incident: input.incidents.get(component.id),
        maintenance: input.maintenance.has(component.id),
      })
    );
  }
  return statuses;
}

const levelIndicator: Readonly<Record<StatusLevel, Indicator>> = {
  degraded_performance: "minor",
  major_outage: "critical",
  operational: "none",
  partial_outage: "major",
  under_maintenance: "maintenance",
};

/** The summary's indicator: the worse of the page level mapped (under maintenance to `maintenance`, degraded performance to `minor`, partial outage to `major`, major outage to `critical`) and the highest impact among the open incidents touching the page. */
export function summaryIndicator(
  level: StatusLevel,
  openImpacts: readonly ImpactLevel[]
): Indicator {
  const worst = [levelIndicator[level], ...openImpacts].map((each) =>
    indicators.indexOf(each)
  );
  return indicators[Math.max(...worst)] ?? "none";
}
