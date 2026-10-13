/**
 * The floor benchmark's numbers shown on the landing page, copied
 * from the last run, bench/floor/results/2026-10-06T07-04-16Z/run-1.json
 * (SQLite variant, one E-core, 240 MB), until a release's run replaces them.
 */

/** The container's memory in MB, one sample a second, through the accelerated day: 1,500 monitors checked every second. The first second, before the process was up, is left out. */
export const dayMemory: readonly number[] = [
  88.4, 144.4, 153.0, 156.8, 132.8, 129.3, 163.7, 141.9, 160.3, 134.8, 137.2,
  147.1, 160.5, 159.7, 151.2, 162.1, 132.3, 160.2, 132.1, 162.6, 106.8, 152.4,
  162.6, 155.9, 154.0, 163.4, 131.4, 162.8, 138.9, 165.1, 126.7, 162.5, 135.6,
  166.2, 172.5, 164.3, 164.8, 152.1, 163.2, 129.5, 168.6, 153.3, 151.9, 110.1,
  150.5, 163.3, 146.7, 169.0, 157.0, 169.9, 146.7, 176.3, 151.5, 154.3, 169.3,
  146.1, 164.9, 134.5, 164.7, 139.3,
];

export const bench = {
  /** When the run took place. */
  ranAt: Date.UTC(2026, 9, 6),
  /** The memory limit the install runs under, in MB. */
  limit: 240,
  /** Monitors at a 20-second interval that fit the limit; the sweep stopped at its ceiling, so more would. */
  capacityMonitors: 800,
  /** The highest resident memory in MB at that capacity. */
  capacityMemory: 107,
  /** The accelerated day: monitors, checks run in its minute, its memory peak in MB and its share of the core. */
  dayMonitors: 1500,
  dayChecks: 77_398,
  dayPeak: 188,
  dayCpuShare: 0.31,
  /** From start to answering, in ms. */
  coldStartMs: 444,
  /** The Linux binary, in MB. */
  binaryMb: 96,
} as const;
