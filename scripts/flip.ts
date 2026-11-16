/**
 * Breaks source, runs the named tests, puts the source back, and says
 * whether a test noticed. `bun run flip --help` prints the whole manual.
 *
 * The source is put back from memory, never from git, so uncommitted edits
 * survive. `.flip.json`, at the root of the repository the run starts in,
 * holds it while the tests run: the next flip puts back a run that was
 * killed outright, and a second flip in the same tree is refused, since each
 * would see the other's broken line.
 */
// biome-ignore lint/style/noRestrictedImports: Bun.write has no exclusive create, which keeps two flips started at once from both running
import { writeFileSync } from "node:fs";

const usage = `usage: bun run flip <file> <search> <replace> -- <bun test arguments>
       bun run flip --sweep <file> [--since <ref>] -- <bun test arguments>

A flip replaces <search>, which must occur once in <file>, runs bun test with the arguments after --, and puts the file back.
A sweep flips each operator, one at a time, on every line of <file> changed since <ref> (main by default, uncommitted edits included; a file git does not track is swept whole).
Name the tests meant to pin the line (their file, -t "<name>"), or a red may come from another test's state.

RED, exit 0: a test failed, so the change is caught.
GREEN, exit 1: every test passed, so no test pins the change; a sweep lists each such flip as line: before ==> after.
NO VERDICT, exit 2: the tests hung, did not compile or matched no test, or the flip was not applied.`;
const timeoutMs = Number(Bun.env.FLIP_TIMEOUT_MS ?? 120_000);

/** What `.flip.json` holds while a flip runs. */
export interface State {
  readonly file: string;
  readonly flipped: string;
  readonly original: string;
  readonly pid: number;
}

type Verdict =
  | { readonly kind: "red"; readonly failed: string[]; readonly ran: string }
  | { readonly kind: "green"; readonly ran: string }
  | { readonly kind: "none"; readonly why: string };

interface Mutant {
  readonly flipped: string;
  readonly where: string;
}

/** Each operator a sweep flips, and what it becomes; the first match on a line only. */
const swaps: readonly (readonly [RegExp, string])[] = [
  [/[=]==/, "!=="],
  [/!==/, "==="],
  [/&&/, "||"],
  [/\|\|/, "&&"],
  [/>=/, ">"],
  [/<=/, "<"],
  [/ > /, " >= "],
  [/ < /, " <= "],
  [/ \+ /, " - "],
  [/\btrue\b/, "false"],
  [/\bfalse\b/, "true"],
];
const notCode = /^(\/\/|\/\*|\*|import\b|$)/;
const passCount = /(\d+) pass/;
const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm;

function stop(message: string): never {
  console.error(message);
  process.exit(2);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const top = await Bun.$`git rev-parse --show-toplevel`.quiet().nothrow();
const repository = top.exitCode === 0 ? top.text().trim() : undefined;
const statePath = `${repository ?? process.cwd()}/.flip.json`;

/** Puts back a flip whose process died before it could, or refuses while one still runs. */
async function recover(): Promise<void> {
  const left = Bun.file(statePath);
  if (!(await left.exists())) {
    return;
  }
  const state: State = await left.json();
  if (alive(state.pid)) {
    stop(
      `another flip (pid ${state.pid}) is running on ${state.file}; one flip at a time, or each run sees the other's broken line`
    );
  }
  if ((await Bun.file(state.file).text()) !== state.flipped) {
    stop(
      `${state.file} changed since a killed flip; its original is in ${statePath}: put it back by hand, then delete that file`
    );
  }
  await Bun.write(state.file, state.original);
  await left.delete();
  console.error(`put back ${state.file} from a killed flip`);
}

let held: { readonly file: string; readonly original: string } | undefined;
let testRun: Bun.Subprocess | undefined;

/** Kills the test run and every process it started: they share its process group. */
function stopTests(): void {
  if (testRun && testRun.exitCode === null && testRun.signalCode === null) {
    try {
      process.kill(-testRun.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function writeState(state: State, flag: "w" | "wx"): void {
  writeFileSync(statePath, JSON.stringify(state), { flag });
}

/** Puts the source back and lets go of `.flip.json`. */
async function release(): Promise<void> {
  stopTests();
  if (held) {
    await Bun.write(held.file, held.original);
  }
  await Bun.file(statePath)
    .delete()
    .catch(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => release().finally(() => process.exit(2)));
}

/** Writes the flipped source, runs the tests, puts the original back, and reads the run. */
async function trial(
  file: string,
  original: string,
  flipped: string,
  testArgs: readonly string[]
): Promise<Verdict> {
  writeState({ file, flipped, original, pid: process.pid }, "w");
  await Bun.write(file, flipped);
  const run = Bun.spawn(["bun", "test", ...testArgs], {
    detached: true,
    stderr: "pipe",
    stdout: "pipe",
  });
  testRun = run;
  let timedOut = false;
  // A flipped loop condition can hang a test forever, so the run is killed at the deadline.
  const deadline = setTimeout(() => {
    timedOut = true;
    stopTests();
  }, timeoutMs);
  await run.exited;
  clearTimeout(deadline);
  // Anything the tests started and left running goes with them.
  try {
    process.kill(-run.pid, "SIGKILL");
  } catch {
    // Nothing was left.
  }
  await Bun.write(file, original);
  writeState({ file, flipped: original, original, pid: process.pid }, "w");
  const output =
    (await new Response(run.stdout).text()) +
    (await new Response(run.stderr).text());
  const failed = output.split("\n").filter((line) => line.startsWith("(fail)"));
  const ran = passCount.exec(output)?.[1] ?? "0";
  if (timedOut) {
    return {
      kind: "none",
      why: `the tests ran past ${timeoutMs / 1000} s and were killed; a flipped loop condition hangs, so narrow the run with -t or flip another line`,
    };
  }
  if (failed.length > 0) {
    return { failed, kind: "red", ran };
  }
  if (run.exitCode === 0) {
    return { kind: "green", ran };
  }
  // A compile error, an error between tests or no matching test proves nothing.
  return {
    kind: "none",
    why: `bun test exited ${run.exitCode} without a failed test\n${output.slice(-1500)}`,
  };
}

function oneFlip(
  target: string,
  original: string,
  search: string,
  replace: string
): Mutant[] {
  if (search === replace) {
    stop("NOT APPLIED: the replacement is the search text");
  }
  const found = original.split(search).length - 1;
  if (found !== 1) {
    stop(
      `NOT APPLIED: the search text occurs ${found} times in ${target}; it must occur once`
    );
  }
  return [{ flipped: original.replace(search, () => replace), where: "" }];
}

/** The lines of the file changed since the ref's merge base, or every line of a file git does not track yet. */
async function changedLines(
  target: string,
  file: string,
  since: string
): Promise<Set<number> | undefined> {
  if (!repository) {
    stop("NOT APPLIED: a sweep runs inside a git repository");
  }
  if (!file.startsWith(`${repository}/`)) {
    stop(`NOT APPLIED: ${target} is outside the repository at ${repository}`);
  }
  const tracked = await Bun.$`git ls-files --error-unmatch -- ${file}`
    .quiet()
    .nothrow();
  if (tracked.exitCode !== 0) {
    return undefined;
  }
  const ref = await Bun.$`git rev-parse --verify --quiet ${`${since}^{commit}`}`
    .quiet()
    .nothrow();
  if (ref.exitCode !== 0) {
    stop(`NOT APPLIED: git knows no ref ${since}`);
  }
  const base = await Bun.$`git merge-base ${since} HEAD`.quiet().nothrow();
  if (base.exitCode !== 0) {
    stop(`NOT APPLIED: ${since} and HEAD share no history`);
  }
  const diff = await Bun.$`git diff -U0 ${base.text().trim()} -- ${file}`
    .quiet()
    .nothrow();
  if (diff.exitCode !== 0) {
    stop(`NOT APPLIED: ${diff.stderr.toString().split("\n")[0]}`);
  }
  const changed = new Set<number>();
  for (const [, start, count] of diff.text().matchAll(hunk)) {
    for (let i = 0; i < Number(count ?? 1); i += 1) {
      changed.add(Number(start) + i);
    }
  }
  return changed;
}

function sweepFlips(
  target: string,
  original: string,
  changed: Set<number> | undefined,
  since: string
): Mutant[] {
  const lines = original.split("\n");
  const mutants = lines.flatMap((line, index) =>
    (changed === undefined || changed.has(index + 1)) &&
    !notCode.test(line.trim())
      ? swaps
          .filter(([pattern]) => pattern.test(line))
          .map(([pattern, swap]) => {
            const after = line.replace(pattern, swap);
            return {
              flipped: lines.with(index, after).join("\n"),
              where: `${index + 1}: ${line.trim()} ==> ${after.trim()}`,
            };
          })
      : []
  );
  if (mutants.length === 0) {
    stop(
      `NOT APPLIED: no line of ${target} changed since ${since} carries an operator to flip`
    );
  }
  return mutants;
}

function reportOne(verdict: Verdict): number {
  if (verdict.kind === "red") {
    console.log(`RED: ${verdict.failed.length} failed, ${verdict.ran} passed`);
    for (const line of verdict.failed.slice(0, 10)) {
      console.log(`  ${line}`);
    }
    return 0;
  }
  if (verdict.kind === "green") {
    console.log(
      `GREEN: the flip survived, ${verdict.ran} tests passed and none failed`
    );
    return 1;
  }
  console.log(`NO VERDICT: ${verdict.why}`);
  return 2;
}

function reportSweep(
  heading: string,
  mutants: readonly Mutant[],
  verdicts: readonly Verdict[]
): number {
  const survivors = mutants.filter((_, i) => verdicts[i]?.kind === "green");
  const unknown = mutants.flatMap((mutant, i) => {
    const verdict = verdicts[i];
    return verdict?.kind === "none"
      ? [`${mutant.where}\n    ${verdict.why.split("\n")[0]}`]
      : [];
  });
  const red = verdicts.filter((verdict) => verdict.kind === "red").length;
  console.log(
    `${heading}: ${mutants.length} mutants, ${red} red, ${survivors.length} survived, ${unknown.length} no verdict`
  );
  for (const mutant of survivors) {
    console.log(`  ${mutant.where}`);
  }
  if (unknown.length > 0) {
    console.log("no verdict:");
    for (const line of unknown) {
      console.log(`  ${line}`);
    }
  }
  if (survivors.length > 0) {
    return 1;
  }
  return unknown.length > 0 ? 2 : 0;
}

if (Bun.argv[2] === "--help" || Bun.argv[2] === "-h") {
  console.log(usage);
  process.exit(0);
}
const split = Bun.argv.indexOf("--");
const named = Bun.argv.slice(2, split === -1 ? undefined : split);
const runArgs = split === -1 ? [] : Bun.argv.slice(split + 1);
const sweeping = named[0] === "--sweep";
const [given, third, fourth] = sweeping ? named.slice(1) : named;
const valid = sweeping
  ? named.length === 2 || (named.length === 4 && third === "--since")
  : third !== undefined && fourth !== undefined;
if (!(given && valid && runArgs.length > 0)) {
  stop(usage);
}
await recover();
const filePath = given.startsWith("/") ? given : `${process.cwd()}/${given}`;
if (!(await Bun.file(filePath).exists())) {
  stop(`NOT APPLIED: there is no file ${given}`);
}
const source = await Bun.file(filePath).text();
const sinceRef = fourth ?? "main";
const changedSet = sweeping
  ? await changedLines(given, filePath, sinceRef)
  : undefined;
const planned = sweeping
  ? sweepFlips(given, source, changedSet, sinceRef)
  : oneFlip(given, source, third ?? "", fourth ?? "");
try {
  writeState(
    { file: filePath, flipped: source, original: source, pid: process.pid },
    "wx"
  );
} catch {
  stop("another flip started at the same moment; one flip at a time");
}
held = { file: filePath, original: source };
const results: Verdict[] = [];
for (const each of planned) {
  // biome-ignore lint/performance/noAwaitInLoops: one flip on disk at a time
  results.push(await trial(filePath, source, each.flipped, runArgs));
}
await release();
const [only] = results;
process.exit(
  sweeping
    ? reportSweep(
        changedSet === undefined
          ? `${given}, not tracked by git, every line`
          : `${given} since ${sinceRef}`,
        planned,
        results
      )
    : reportOne(only ?? { kind: "none", why: "no flip ran" })
);
