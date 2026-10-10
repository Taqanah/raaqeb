/**
 * The report viewer: one run's results beside the previous
 * release's history row and the noise band, the "floor broken" banner on
 * top, a chart for each part with its table. The harness writes the data
 * into the built page, so it opens from disk. Written for the maintainer
 * who reads it, in English, as every harness output is.
 */
import { createRoot } from "react-dom/client";
import type { NoiseBand } from "../band.ts";
import { lateBoundMs, type MinuteLateness } from "../measure.ts";
import { type ReportData, reportDataId } from "../report.ts";
import {
  type CapacityStep,
  type ContainerRun,
  cpuOverTime,
  type FloorBreak,
  type HistoryColumn,
  historyColumns,
  type LoadSummary,
  type PhaseSummary,
  type RunResult,
  type ThroughputPath,
  throughputPaths,
  type VariantResult,
} from "../results.ts";
import { compare } from "./chart.ts";
import { BarChart, LineChart, type Series } from "./charts.tsx";

const limitBytes = 240 * 2 ** 20;

/** The memory axis steps in quarters of the limit, and grows by those steps past it. */
const memoryStep = limitBytes / 4;

function megabytes(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

function milliseconds(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function minutes(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en");
}

function perSecond(value: number): string {
  return `${count(value)}/s`;
}

/** A share of the install's one core. */
function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** The CPU axis steps in quarters of the one core, and grows by those steps past it. */
const cpuStep = 0.25;

const columns: Readonly<
  Record<
    HistoryColumn,
    { readonly format: (value: number) => string; readonly label: string }
  >
> = {
  cachedRequestsPerSecond: {
    format: perSecond,
    label: "Cached public page requests",
  },
  cgroupPeakBytes: { format: megabytes, label: "Cgroup peak" },
  coldStartMs: { format: milliseconds, label: "Cold start" },
  diskBytesPerMonitorPerDay: {
    format: (value) => `${(value / 1024).toFixed(1)} KB`,
    label: "Disk per monitor per day",
  },
  idleRssBytes: { format: megabytes, label: "Idle RSS" },
  loadRssBytes: { format: megabytes, label: "RSS under load" },
  monitorsThatFit: { format: count, label: "Monitors that fit" },
  publicJavaScriptBytes: {
    format: (value) => `${(value / 1024).toFixed(1)} KB`,
    label: "Public page JavaScript (gzip)",
  },
  publicJavaScriptZstdBytes: {
    format: (value) => `${(value / 1024).toFixed(1)} KB`,
    label: "Public page JavaScript (zstd)",
  },
};

const unmeasuredWords = {
  lateness: "no whole minute of lateness",
  load: "no load report from oha",
  oom: "no OOM state from Docker",
  rss: "a quarter of the day without RSS",
} as const;

function reasonOf(item: FloorBreak): string {
  switch (item.kind) {
    case "oom":
      return `${item.variant}: the kernel killed the install at the limit in the ${item.part} part`;
    case "late":
      return `${item.variant}: a minute of the ${item.part} part had a median lateness of ${milliseconds(item.medianMs)}, past its ${milliseconds(item.intervalMs)} interval and one tick`;
    case "load_errors":
      return `${item.variant}: the load phase saw ${item.serverErrors} 5xx answers and ${item.errors} dropped or failed connections`;
    case "unmeasured":
      return `${item.variant}: ${unmeasuredWords[item.what]} in the ${item.part} part`;
    default:
      return `${item.variant}: RSS was still rising in the accelerated day's last quarter`;
  }
}

function Banner(props: { readonly floor: readonly FloorBreak[] }) {
  const broken = props.floor.filter((item) => item.kind !== "unmeasured");
  const unmeasured = props.floor.filter((item) => item.kind === "unmeasured");
  if (broken.length > 0) {
    return (
      <div className="banner" role="alert">
        <strong>⚠ Floor broken.</strong>
        <ul>
          {props.floor.map((item) => (
            <li key={reasonOf(item)}>{reasonOf(item)}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (unmeasured.length > 0) {
    return (
      <div className="banner unverified" role="status">
        <strong>? Floor not verified.</strong> Nothing measured broke it, but
        these rules could not be judged:
        <ul>
          {unmeasured.map((item) => (
            <li key={reasonOf(item)}>{reasonOf(item)}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="banner held" role="status">
      <strong>✓ Floor held.</strong> Every rule was judged on every part the run
      measured, and none broke.
    </div>
  );
}

function History(props: {
  readonly band: NoiseBand | undefined;
  readonly data: ReportData;
}) {
  const { previous, row } = props.data;
  return (
    <section className="card">
      <h2>The history row</h2>
      <p className="note">
        {previous
          ? `Against release ${previous.release} (${previous.date}, ${previous.commit.slice(0, 12)}).`
          : "No earlier release in the history: nothing to compare yet."}{" "}
        {props.band
          ? `Noise band of ${props.band.runs} runs measured ${props.band.measuredAt.slice(0, 10)}.`
          : "No stored noise band."}
      </p>
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>This run</th>
              <th>Previous</th>
              <th>Difference</th>
              <th>Band</th>
            </tr>
          </thead>
          <tbody>
            {historyColumns.map((column) => {
              const { format, label } = columns[column];
              const band = props.band?.columns[column];
              const comparison = compare(row[column], previous?.[column], band);
              return (
                <tr key={column}>
                  <td>{label}</td>
                  <td>{row[column] === null ? "–" : format(row[column])}</td>
                  <td>
                    {previous?.[column] === null ||
                    previous?.[column] === undefined
                      ? "–"
                      : format(previous[column])}
                  </td>
                  <td
                    className={
                      comparison.kind === "compared" && comparison.beyondNoise
                        ? "beyond"
                        : undefined
                    }
                  >
                    {comparison.kind === "compared"
                      ? `${comparison.difference >= 0 ? "+" : "−"}${format(Math.abs(comparison.difference))}${comparison.beyondNoise ? " beyond noise" : ""}`
                      : "–"}
                  </td>
                  <td>
                    {band ? `${format(band.low)} to ${format(band.high)}` : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The memory series of one container: VmRSS and memory.current from the host, the JavaScript heap from the sampler. */
function memorySeries(run: ContainerRun): Series[] {
  const start = run.samples.host[0]?.at ?? 0;
  const seconds = (at: number) => (at - start) / 1000;
  return [
    {
      colour: "var(--series-1)",
      name: "VmRSS",
      points: run.samples.host.flatMap((sample) =>
        sample.vmRss === null
          ? []
          : [{ x: seconds(sample.at), y: sample.vmRss }]
      ),
    },
    {
      colour: "var(--series-2)",
      name: "memory.current",
      points: run.samples.host.map((sample) => ({
        x: seconds(sample.at),
        y: sample.memoryCurrent,
      })),
    },
    {
      colour: "var(--series-3)",
      name: "JS heap",
      points: run.samples.inside.map((sample) => ({
        x: seconds(sample.at),
        y: sample.heapSize,
      })),
    },
  ];
}

function MemoryChart(props: {
  readonly description: string;
  readonly run: ContainerRun;
}) {
  const series = memorySeries(props.run);
  const highest = Math.max(
    limitBytes,
    ...series.flatMap((each) => each.points.map((point) => point.y))
  );
  return (
    <LineChart
      description={props.description}
      empty="The host took no reading of this container."
      gap={10}
      limit={{ label: "240 MB limit", value: limitBytes }}
      series={series}
      top={Math.ceil(highest / memoryStep) * memoryStep}
      x={minutes}
      y={megabytes}
    />
  );
}

function CpuChart(props: {
  readonly description: string;
  readonly run: ContainerRun;
}) {
  const start = props.run.samples.host[0]?.at ?? 0;
  const points = cpuOverTime(props.run.samples.host).map((reading) => ({
    x: (reading.at - start) / 1000,
    y: reading.share,
  }));
  const highest = Math.max(1, ...points.map((point) => point.y));
  return (
    <LineChart
      description={props.description}
      empty="The host took no two readings of this container."
      gap={10}
      limit={{ label: "one core", value: 1 }}
      series={[{ colour: "var(--series-1)", name: "CPU", points }]}
      top={Math.ceil(highest / cpuStep) * cpuStep}
      x={minutes}
      y={percent}
    />
  );
}

/** A phase's share of its core, with the seconds the quota held it back when it did. */
function cpuCell(phase: PhaseSummary): string {
  const throttled = phase.throttledSeconds ?? 0;
  return `${stat(phase.cpuShare, percent)}${throttled > 0 ? `, throttled ${throttled.toFixed(1)} s` : ""}`;
}

function LatenessChart(props: {
  readonly intervalMs: number;
  readonly minutes: readonly MinuteLateness[];
  readonly what: string;
}) {
  return (
    <>
      <LineChart
        description={`Median lateness of each minute of ${props.what}`}
        empty="No whole minute was measured."
        gap={60}
        limit={{
          label: "interval and one tick",
          value: lateBoundMs(props.intervalMs),
        }}
        series={[
          {
            colour: "var(--series-1)",
            name: "median lateness",
            points: props.minutes.map((minute) => ({
              x: minute.minute / 1000,
              y: minute.medianMs,
            })),
          },
        ]}
        x={minutes}
        y={milliseconds}
      />
      <details>
        <summary>Table</summary>
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Minute</th>
                <th>Checks</th>
                <th>Past the bound</th>
                <th>Median lateness</th>
              </tr>
            </thead>
            <tbody>
              {props.minutes.map((minute) => (
                <tr key={minute.minute}>
                  <td>{minutes(minute.minute / 1000)}</td>
                  <td>{count(minute.checks)}</td>
                  <td>{count(minute.late)}</td>
                  <td>{milliseconds(minute.medianMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function stat(value: number | null | undefined, format: (n: number) => string) {
  return value === null || value === undefined ? "–" : format(value);
}

function loadCells(load: LoadSummary | null) {
  return load
    ? `${count(load.requestsPerSecond)}/s, p95 ${stat(load.latencyMs?.p95, milliseconds)}`
    : "–";
}

function Variants(props: { readonly variants: readonly VariantResult[] }) {
  return (
    <section className="card">
      <h2>The fixed run, each variant</h2>
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th>Image</th>
              <th>Cold start</th>
              <th>Idle VmRSS</th>
              <th>VmRSS under load</th>
              <th>Cgroup peak</th>
              <th>CPU idle</th>
              <th>CPU under load</th>
              <th>Load</th>
              <th>5xx / failed</th>
              <th>Email / webhook sends</th>
            </tr>
          </thead>
          <tbody>
            {props.variants.map(({ fixed, image, variant }) => (
              <tr key={variant}>
                <td>{variant}</td>
                <td>{image}</td>
                <td>{stat(fixed.coldStartMs, milliseconds)}</td>
                <td>{stat(fixed.phases.idle.vmRss?.median, megabytes)}</td>
                <td>{stat(fixed.phases.load.vmRss?.max, megabytes)}</td>
                <td>{stat(fixed.memoryPeak, megabytes)}</td>
                <td>{cpuCell(fixed.phases.idle)}</td>
                <td>{cpuCell(fixed.phases.load)}</td>
                <td>{loadCells(fixed.load)}</td>
                <td>
                  {fixed.load
                    ? `${fixed.load.serverErrors} / ${Object.values(fixed.load.errors).reduce((a, b) => a + b, 0)}`
                    : "–"}
                </td>
                <td>
                  {stat(fixed.sends.email, count)} /{" "}
                  {stat(fixed.sends.webhook, count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.variants.map(({ fixed, variant }) => (
        <div key={variant}>
          <h2 style={{ marginTop: 16 }}>Memory of the {variant} fixed run</h2>
          <MemoryChart
            description={`Memory of the ${variant} fixed run over time`}
            run={fixed}
          />
          <h3 className="note">CPU of the {variant} fixed run</h3>
          <CpuChart
            description={`CPU of the ${variant} fixed run over time, as a share of its one core`}
            run={fixed}
          />
        </div>
      ))}
    </section>
  );
}

function Day(props: { readonly variant: VariantResult }) {
  const { day } = props.variant;
  if (!day) {
    return null;
  }
  return (
    <section className="card">
      <h2>The accelerated day</h2>
      <p className="note">
        {count(day.checks)} checks at 1 s in {minutes(day.phase.seconds)}; the
        install sealed {count(day.sealedMonitorDays)} monitor-days of the seeded
        yesterday at{" "}
        {stat(
          day.diskBytesPerMonitorPerDay,
          (n) => `${(n / 1024).toFixed(1)} KB`
        )}{" "}
        each. Sends: {stat(day.sends.email, count)} emails,{" "}
        {stat(day.sends.webhook, count)} webhooks. CPU, as a share of its one
        core: {cpuCell(day.phase)}.
      </p>
      <MemoryChart description="Memory over the accelerated day" run={day} />
      <h3 className="note">CPU over the accelerated day</h3>
      <CpuChart
        description="CPU over the accelerated day, as a share of its one core"
        run={day}
      />
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>VmRSS mean</th>
              <th>First quarter</th>
              <th>Second</th>
              <th>Third</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>bytes</td>
              {day.quarters.map((quarter, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: four quarters in their fixed order
                <td key={index}>{stat(quarter, megabytes)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <h2 style={{ marginTop: 16 }}>Lateness at 1 s</h2>
      <LatenessChart
        intervalMs={1000}
        minutes={day.lateness}
        what="the accelerated day"
      />
    </section>
  );
}

/** Why a count did or did not fit, in the rule's own order. */
function stepWhy(step: CapacityStep): string {
  if (step.fits) {
    return "fits";
  }
  if (step.oom !== "none") {
    return step.oom === "killed"
      ? "does not fit: killed at the limit"
      : "does not fit: its OOM state could not be read";
  }
  return step.medianLatenessMs === null
    ? "does not fit: no check started in its measured span"
    : "does not fit: late past one interval and one tick";
}

function Capacity(props: { readonly variant: VariantResult }) {
  const { capacity } = props.variant;
  if (!capacity) {
    return null;
  }
  const label = (monitors: number) => `${count(monitors)} monitors`;
  return (
    <section className="card">
      <h2>The capacity sweep at {capacity.intervalSeconds} s</h2>
      <p className="note">
        Monitors that fit: {capacity.atCeiling ? "at least " : ""}
        {stat(capacity.monitorsThatFit, count)}
        {capacity.atCeiling ? ", the sweep's largest count" : ""}.
      </p>
      <h3 className="note">Cgroup peak at each count</h3>
      <BarChart
        bars={capacity.steps.map((step) => ({
          detail: stepWhy(step),
          label: label(step.monitors),
          value: step.memoryPeak,
        }))}
        description="Cgroup peak at each count of the capacity sweep"
        format={megabytes}
      />
      <h3 className="note">CPU over the measured span of each count</h3>
      <BarChart
        bars={capacity.steps.map((step) => ({
          label: label(step.monitors),
          value: step.cpuShare,
        }))}
        description="Share of its one core the install used over the measured span of each count"
        format={percent}
      />
      <h3 className="note">Median lateness at the end of each count</h3>
      <BarChart
        bars={capacity.steps.map((step) => ({
          label: label(step.monitors),
          value: step.medianLatenessMs,
        }))}
        description="Median lateness at the end of each count"
        format={milliseconds}
      />
      <details>
        <summary>Table</summary>
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Monitors</th>
                <th>Fits</th>
                <th>OOM</th>
                <th>Cgroup peak</th>
                <th>VmRSS highest</th>
                <th>CPU</th>
                <th>Median lateness</th>
              </tr>
            </thead>
            <tbody>
              {capacity.steps.map((step) => (
                <tr key={step.monitors}>
                  <td>{count(step.monitors)}</td>
                  <td>{step.fits ? "yes" : "no"}</td>
                  <td>{step.oom}</td>
                  <td>{stat(step.memoryPeak, megabytes)}</td>
                  <td>{stat(step.vmRssMax, megabytes)}</td>
                  <td>{stat(step.cpuShare, percent)}</td>
                  <td>{stat(step.medianLatenessMs, milliseconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

const pathNames: Readonly<Record<ThroughputPath, string>> = {
  hit: "memo hit",
  notModified: "304 on the document",
  perChange: "a render per change",
  uncached: "uncached render",
};

function Throughput(props: { readonly variant: VariantResult }) {
  const { throughput } = props.variant;
  if (!throughput) {
    return null;
  }
  return (
    <section className="card">
      <h2>The throughput sweep, {throughput.seconds} s a path</h2>
      <BarChart
        bars={throughputPaths.map((path) => ({
          label: pathNames[path],
          value: throughput.paths[path]?.requestsPerSecond ?? null,
        }))}
        description="Requests a second each path of the public page answered"
        format={perSecond}
      />
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Requests a second</th>
              <th>CPU</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
              <th>Statuses</th>
            </tr>
          </thead>
          <tbody>
            {throughputPaths.map((path) => {
              const load = throughput.paths[path];
              return (
                <tr key={path}>
                  <td>{pathNames[path]}</td>
                  <td>{stat(load?.requestsPerSecond, count)}</td>
                  <td>{stat(throughput.cpuShare[path], percent)}</td>
                  <td>{stat(load?.latencyMs?.p50, milliseconds)}</td>
                  <td>{stat(load?.latencyMs?.p95, milliseconds)}</td>
                  <td>{stat(load?.latencyMs?.p99, milliseconds)}</td>
                  <td>
                    {load
                      ? Object.entries(load.statusCodes)
                          .map(([code, n]) => `${code}: ${count(n)}`)
                          .join(", ")
                      : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Report(props: { readonly data: ReportData }) {
  const { band, result } = props.data;
  const sqlite = result.variants.find((each) => each.variant === "sqlite");
  return (
    <main>
      <h1>Raaqeb floor benchmark</h1>
      <Header result={result} />
      <Banner floor={result.floor} />
      <History band={band} data={props.data} />
      <Variants variants={result.variants} />
      {sqlite ? (
        <section className="card">
          <h2>Lateness of the SQLite fixed run</h2>
          <LatenessChart
            intervalMs={result.flags.intervalSeconds * 1000}
            minutes={sqlite.fixed.lateness}
            what="the fixed run"
          />
        </section>
      ) : null}
      {sqlite ? <Day variant={sqlite} /> : null}
      {sqlite ? <Capacity variant={sqlite} /> : null}
      {sqlite ? <Throughput variant={sqlite} /> : null}
    </main>
  );
}

function Header(props: { readonly result: RunResult }) {
  const { cores, flags, machine } = props.result;
  return (
    <p className="meta">
      {props.result.startedAt} · commit {props.result.commit.slice(0, 12)}
      {props.result.dirty ? " (dirty tree)" : ""}
      {props.result.wiring ? " · wiring run, never quote these numbers" : ""}
      {props.result.standIn ? " · stand-in, not a shipped image" : ""} ·{" "}
      {flags.monitors} monitors at {flags.intervalSeconds} s · {machine.cpu},{" "}
      {machine.cores} cores · installs on{" "}
      {cores.kind === "efficiency" ? "efficiency cores" : "cores"}{" "}
      {cores.measured.join(", ")}
    </p>
  );
}

const element = document.getElementById(reportDataId);
const root = document.getElementById("root");
if (element && root) {
  // The harness wrote this JSON from its own results file: the parse boundary.
  const data = JSON.parse(element.textContent ?? "{}") as ReportData;
  createRoot(root).render(<Report data={data} />);
}
