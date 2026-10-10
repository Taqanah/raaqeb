/**
 * A maintenance window's reach (CONTEXT.md "Maintenance window", "Observed
 * time"): while in progress it puts every
 * component it affects under maintenance, and covers every monitor linked
 * to one of them, whatever their other components show; a monitor linked
 * to nothing is never covered. The time a window was in progress leaves its
 * components' and its covered monitors' observed time. Reach reads the
 * links as they are now, since no link history is kept. Pure: every record and `now` are parameters.
 */
import type { Span } from "@/shared/domain/uptime.ts";
import type { Component } from "@/shared/schemas/component.ts";
import type { MaintenanceWindow } from "@/shared/schemas/maintenance.ts";

/** A window as its reach reads it. */
export type WindowReach = Pick<
  MaintenanceWindow,
  "componentIds" | "endsAt" | "stage" | "startsAt"
>;

/** A component's links as reach reads them. */
export type ComponentLinks = Pick<Component, "id" | "monitorIds">;

const inProgress = (window: WindowReach) => window.stage === "in_progress";

/** The components under maintenance now: every one a window in progress affects. */
export function underMaintenance(windows: readonly WindowReach[]): Set<string> {
  return new Set(
    windows.filter(inProgress).flatMap((each) => each.componentIds)
  );
}

/** The monitors covered now: every one linked to a component under maintenance. */
export function coveredMonitors(
  windows: readonly WindowReach[],
  components: readonly ComponentLinks[]
): Set<string> {
  const held = underMaintenance(windows);
  return new Set(
    components
      .filter((component) => held.has(component.id))
      .flatMap((component) => component.monitorIds)
  );
}

/** The spans each component spent under maintenance up to `now`, by component id: every started window's, from its start to its end or now. */
export function maintenanceSpans(
  windows: readonly WindowReach[],
  now: number
): Map<string, Span[]> {
  const spans = new Map<string, Span[]>();
  for (const window of windows) {
    const span = { from: window.startsAt, to: Math.min(window.endsAt, now) };
    if (window.stage === "scheduled" || span.from >= span.to) {
      continue;
    }
    for (const id of window.componentIds) {
      spans.set(id, [...(spans.get(id) ?? []), span]);
    }
  }
  return spans;
}

/** The spans each monitor was covered up to `now`, by monitor id, through the components linked to it now. */
export function coveredSpans(
  windows: readonly WindowReach[],
  components: readonly ComponentLinks[],
  now: number
): Map<string, Span[]> {
  const byComponent = maintenanceSpans(windows, now);
  const spans = new Map<string, Span[]>();
  for (const component of components) {
    const held = byComponent.get(component.id) ?? [];
    for (const id of held.length > 0 ? component.monitorIds : []) {
      spans.set(id, [...(spans.get(id) ?? []), ...held]);
    }
  }
  return spans;
}

/** When the scheduler next moves a window: the soonest start of a scheduled one or end of one in progress; nothing when none is left to move. */
export function nextEdge(windows: readonly WindowReach[]): number | undefined {
  const edges = windows.flatMap((window) => {
    if (window.stage === "scheduled") {
      return [window.startsAt];
    }
    return window.stage === "in_progress" ? [window.endsAt] : [];
  });
  return edges.length === 0 ? undefined : Math.min(...edges);
}
