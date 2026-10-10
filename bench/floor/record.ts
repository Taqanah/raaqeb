/**
 * `bun run bench:record <run.json> <release>`: appends a release run's row to
 * `bench/floor/history.jsonl`, which the next release's report compares against.
 */
import { type HistoryRow, historyRow, type RunResult } from "./results.ts";

/** Appends the row of the run in `runFile` to `history` as release `release`; refuses a run that is not a release's, and a release already in the file. */
export async function appendRow(
  history: string,
  runFile: string,
  release: string
): Promise<HistoryRow> {
  // The file is the harness's own output, written by run.ts.
  const result = (await Bun.file(runFile).json()) as RunResult;
  const made = historyRow(result, release);
  if (!made.ok) {
    throw new Error(made.message);
  }
  const before = await Bun.file(history)
    .text()
    .catch(() => "");
  const rows = before.split("\n").filter((line) => line.trim() !== "");
  if (
    rows.some((line) => (JSON.parse(line) as HistoryRow).release === release)
  ) {
    throw new Error(`${release} already has a row in ${history}`);
  }
  await Bun.write(
    history,
    `${[...rows, JSON.stringify(made.row)].join("\n")}\n`
  );
  return made.row;
}

if (import.meta.main) {
  const [runFile, release] = Bun.argv.slice(2);
  if (!(runFile && release)) {
    process.stderr.write("usage: bun run bench:record <run.json> <release>\n");
    process.exit(2);
  }
  const row = await appendRow(
    `${import.meta.dir}/history.jsonl`,
    runFile,
    release
  ).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    return process.exit(1);
  });
  process.stdout.write(
    `appended ${row.release} to bench/floor/history.jsonl\n`
  );
}
