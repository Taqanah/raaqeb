/**
 * How long one check can take (CONTEXT.md "Check"): its attempts,
 * each bounded by the monitor's timeout, with a fixed pause between two.
 * The attempt loop pauses by it, and the admin area waits by it. No I/O.
 */
import type { Monitor } from "@/shared/schemas/monitor.ts";

/** The pause between two attempts of one check. */
export const retryDelayMs = 1000;

/** The longest one check of this monitor can take: every attempt at its timeout and the pauses between them. */
export function longestCheckMs({
  retries,
  timeoutMs,
}: Pick<Monitor, "retries" | "timeoutMs">): number {
  return (retries + 1) * timeoutMs + retries * retryDelayMs;
}

/** Whether the newest check the page shows is the one "check now" asked for, or a later one: it started at the answer's `from` or after. */
export function askedCheckLanded(
  newestAt: number | undefined,
  from: number
): boolean {
  return newestAt !== undefined && newestAt >= from;
}
