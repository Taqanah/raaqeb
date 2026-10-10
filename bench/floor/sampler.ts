/**
 * The inside view: loaded with `--preload` when the harness
 * starts the container, never part of the product tree. With
 * `RAAQEB_BENCH_SAMPLE_MS` set it writes one JSON line to standard output
 * at that interval, carrying the process's RSS and JavaScriptCore's heap
 * size; RSS minus the heap tells native memory from a JavaScript leak.
 * Without the variable it does nothing. It imports nothing of the harness,
 * because it is the one file mounted into the container.
 */
import { heapStats } from "bun:jsc";

/** The variable that turns the sampler on, in milliseconds. */
export const sampleVariable = "RAAQEB_BENCH_SAMPLE_MS";

/** The marker a sample line carries, so the harness can find it among the install's log lines. */
export const sampleMarker = "raaqeb-bench-sample";

const wholeNumber = /^[1-9]\d*$/;

/** The interval a variable's value asks for, or nothing for a value that is not a whole number above zero. */
export function sampleEvery(value: string): number | undefined {
  return wholeNumber.test(value) ? Number(value) : undefined;
}

/** One sample as the line the harness reads back. */
export function sampleLine(at: number, rss: number, heapSize: number): string {
  return JSON.stringify({ [sampleMarker]: 1, at, heapSize, rss });
}

const asked = process.env[sampleVariable];
const every = asked === undefined ? undefined : sampleEvery(asked);
if (every !== undefined) {
  setInterval(() => {
    process.stdout.write(
      `${sampleLine(Date.now(), process.memoryUsage.rss(), heapStats().heapSize)}\n`
    );
  }, every).unref();
}
