/**
 * An outage's stored shape (CONTEXT.md "Outage"): one monitor
 * being down from its first confirmed down check to its first recovered
 * check, with the reason of the check that opened it. Keyed like the head
 * row that opened it, by monitor and started-at; kept on its own so it
 * outlives the checks, and never deleted by retention or the size budget.
 */
import type { ReasonCode } from "./reason.ts";

export interface Outage {
  /** When the operator acknowledged it, which stops its reminders and nothing else; none until then. */
  readonly acknowledgedAt?: number;
  /** The first recovered check's time; none while the outage is open. */
  readonly endedAt: number | undefined;
  readonly monitorId: string;
  /** The reason of the check that opened it, fixed for the outage's life. */
  readonly reason: ReasonCode;
  /** The first failed check's time; the interface says "detected at". */
  readonly startedAt: number;
}
