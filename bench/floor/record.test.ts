import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { runResult } from "./fixture.ts";
import { appendRow } from "./record.ts";

let scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.map((dir) => $`rm -rf ${dir}`.quiet()));
  scratch = [];
});

/** A folder holding a history file with this text, and a run file with this result. */
async function folder(
  history: string,
  result = runResult()
): Promise<{ history: string; run: string }> {
  const dir = (await $`mktemp -d`.text()).trim();
  scratch.push(dir);
  await Bun.write(`${dir}/history.jsonl`, history);
  await Bun.write(`${dir}/run-1.json`, JSON.stringify(result));
  return { history: `${dir}/history.jsonl`, run: `${dir}/run-1.json` };
}

describe("recording a release's row", () => {
  test("appends one line with the release, the commit and the day, after the rows already there", async () => {
    const files = await folder("");
    const first = await appendRow(files.history, files.run, "0.1.0");
    const second = await appendRow(files.history, files.run, "0.2.0");
    const lines = (await Bun.file(files.history).text()).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);
    expect([first.release, second.release]).toEqual(["0.1.0", "0.2.0"]);
    expect(first.commit).toBe(runResult().commit);
  });

  test("keeps the earlier rows byte for byte, even when the file does not end in a newline", async () => {
    const files = await folder('{"release":"0.0.9"}');
    await appendRow(files.history, files.run, "0.1.0");
    const text = await Bun.file(files.history).text();
    expect(text.startsWith('{"release":"0.0.9"}\n{')).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("refuses a wiring run, naming why, and leaves the file as it was", async () => {
    const files = await folder("", runResult({ wiring: true }));
    await expect(appendRow(files.history, files.run, "0.1.0")).rejects.toThrow(
      "a wiring run is never a history row"
    );
    expect(await Bun.file(files.history).text()).toBe("");
  });

  test("refuses a release that already has a row", async () => {
    const files = await folder("");
    await appendRow(files.history, files.run, "0.1.0");
    const before = await Bun.file(files.history).text();
    await expect(appendRow(files.history, files.run, "0.1.0")).rejects.toThrow(
      "0.1.0 already has a row"
    );
    expect(await Bun.file(files.history).text()).toBe(before);
  });

  test("starts the file when there is none", async () => {
    const files = await folder("");
    await $`rm ${files.history}`.quiet();
    await appendRow(files.history, files.run, "0.1.0");
    expect(await Bun.file(files.history).text()).toContain('"release":"0.1.0"');
  });
});
