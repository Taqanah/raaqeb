/**
 * A probe's state (CONTEXT.md "Probe"), as the locations page and the
 * management API both name it. Pure: `now` is a parameter.
 */
import { type Probe, probeSilentAfterMs } from "@/shared/schemas/probe.ts";

/** `never`: not heard from yet; `reporting`: heard within four of its pulls; `silent`: not for longer; `refused`: the install refused its latest push whole. */
export const probeStates = ["never", "reporting", "silent", "refused"] as const;
export type ProbeState = (typeof probeStates)[number];

/** The probe's state at `now`; a refused push outranks the last contact, since the page never shows such a probe as reporting. */
export function probeStateOf(
  probe: Pick<Probe, "lastSeenAt">,
  now: number,
  refused: boolean
): ProbeState {
  if (refused) {
    return "refused";
  }
  if (probe.lastSeenAt === undefined) {
    return "never";
  }
  return now - probe.lastSeenAt < probeSilentAfterMs ? "reporting" : "silent";
}
