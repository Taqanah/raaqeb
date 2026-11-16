import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { State } from "./flip.ts";

const flipScript = `${import.meta.dir}/flip.ts`;
const source =
  "export const double = (n: number) => n * 2;\nexport const unused = () => 1;\n";
const spec = `import { expect, test } from "bun:test";
import { double } from "./math.ts";
test("double doubles", () => { expect(double(2)).toBe(4); });
`;

let dir = "";
beforeEach(async () => {
  dir = (await Bun.$`mktemp -d`.text()).trim();
  await Bun.write(`${dir}/math.ts`, source);
  await Bun.write(`${dir}/math.test.ts`, spec);
});
afterEach(async () => {
  await Bun.$`rm -rf ${dir}`.quiet();
});

function flip(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", flipScript, ...args], {
    cwd: dir,
    env: { ...Bun.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function run(args: string[], env: Record<string, string> = {}) {
  const child = flip(args, env);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, err, out };
}

const mathNow = () => Bun.file(`${dir}/math.ts`).text();
const leaveState = (state: Omit<State, "file">) =>
  Bun.write(
    `${dir}/.flip.json`,
    JSON.stringify({ ...state, file: `${dir}/math.ts` })
  );

describe("a flip", () => {
  test("a test that notices the broken line is RED, exit 0, and the source is put back", async () => {
    const result = await run([
      "math.ts",
      "n * 2",
      "n * 3",
      "--",
      "./math.test.ts",
    ]);
    expect(result.out).toStartWith("RED: 1 failed");
    expect(result.out).toContain("double doubles");
    expect(result.code).toBe(0);
    expect(await mathNow()).toBe(source);
  });

  test("a broken line no test notices is GREEN, exit 1, and the source is put back", async () => {
    const result = await run([
      "math.ts",
      "=> 1",
      "=> 2",
      "--",
      "./math.test.ts",
    ]);
    expect(result.out).toStartWith("GREEN");
    expect(result.code).toBe(1);
    expect(await mathNow()).toBe(source);
  });

  test("a flip that no longer compiles is NO VERDICT, exit 2", async () => {
    const result = await run([
      "math.ts",
      "n * 2",
      "n * (",
      "--",
      "./math.test.ts",
    ]);
    expect(result.out).toStartWith("NO VERDICT");
    expect(result.code).toBe(2);
    expect(await mathNow()).toBe(source);
  });

  test("a test run that hangs is killed, says it timed out, exit 2, and the source is put back", async () => {
    await Bun.write(
      `${dir}/math.test.ts`,
      `import { test } from "bun:test";
import { double } from "./math.ts";
test("spins", () => { while (double(1) !== 3) {} });
`
    );
    const result = await run(
      ["math.ts", "=> 1", "=> 2", "--", "./math.test.ts"],
      {
        FLIP_TIMEOUT_MS: "1500",
      }
    );
    expect(result.out).toStartWith(
      "NO VERDICT: the tests ran past 1.5 s and were killed"
    );
    expect(result.code).toBe(2);
    expect(await mathNow()).toBe(source);
  });
});

describe("a flip that is not applied", () => {
  test("search text that is not in the file is refused, exit 2", async () => {
    const result = await run([
      "math.ts",
      "n * 9",
      "n * 3",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toContain("occurs 0 times");
    expect(result.code).toBe(2);
    expect(await mathNow()).toBe(source);
  });

  test("search text that occurs twice is refused, exit 2", async () => {
    const result = await run([
      "math.ts",
      "export const",
      "const",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toContain("occurs 2 times");
    expect(result.code).toBe(2);
  });

  test("a replacement equal to the search text is refused, exit 2", async () => {
    const result = await run([
      "math.ts",
      "n * 2",
      "n * 2",
      "--",
      "./math.test.ts",
    ]);
    expect(result.code).toBe(2);
  });

  test("a flip without its replacement prints the usage, exit 2", async () => {
    const result = await run(["math.ts", "n * 2", "--", "./math.test.ts"]);
    expect(result.err).toContain("usage:");
    expect(result.code).toBe(2);
    expect(await mathNow()).toBe(source);
  });

  test("a sweep with an option other than --since prints the usage, exit 2", async () => {
    const result = await run([
      "--sweep",
      "math.ts",
      "--base",
      "HEAD",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toContain("usage:");
    expect(result.code).toBe(2);
  });

  test("a file that does not exist is not applied, exit 2, in one line", async () => {
    for (const args of [
      ["nope.ts", "a", "b", "--", "./math.test.ts"],
      ["--sweep", "nope.ts", "--", "./math.test.ts"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one mode after the other
      const result = await run(args);
      expect(result.err).toBe("NOT APPLIED: there is no file nope.ts\n");
      expect(result.code).toBe(2);
    }
  });

  test("--help prints what each verdict and exit code means, exit 0", async () => {
    const result = await run(["--help"]);
    expect(result.out).toContain("RED, exit 0:");
    expect(result.out).toContain("GREEN, exit 1:");
    expect(result.out).toContain("NO VERDICT, exit 2:");
    expect(result.code).toBe(0);
  });

  test("no test arguments prints the usage, exit 2", async () => {
    const result = await run(["math.ts", "n * 2", "n * 3"]);
    expect(result.err).toContain("usage:");
    expect(result.code).toBe(2);
  });
});

describe("a flip that was interrupted", () => {
  test("SIGTERM during the test run puts the source back", async () => {
    await Bun.write(
      `${dir}/math.test.ts`,
      `${spec}test("slow", async () => { await Bun.sleep(20_000); }, 30_000);\n`
    );
    const child = flip(["math.ts", "n * 2", "n * 3", "--", "./math.test.ts"]);
    const flipped = Date.now() + 10_000;
    // biome-ignore lint/performance/noAwaitInLoops: polls until the flip is on disk
    while (!(await mathNow()).includes("n * 3") && Date.now() < flipped) {
      await Bun.sleep(50);
    }
    expect(await mathNow()).toContain("n * 3");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(2);
    expect(await mathNow()).toBe(source);
    expect(await Bun.file(`${dir}/.flip.json`).exists()).toBe(false);
  });

  test("SIGTERM stops the test run and the processes it started", async () => {
    await Bun.write(
      `${dir}/math.test.ts`,
      `${spec}test("slow", async () => {
  const sleeper = Bun.spawn(["sleep", "30"]);
  await Bun.write("pids", \`\${process.pid} \${sleeper.pid}\`);
  await Bun.sleep(20_000);
}, 30_000);\n`
    );
    const child = flip(["math.ts", "n * 2", "n * 3", "--", "./math.test.ts"]);
    const deadline = Date.now() + 10_000;
    // biome-ignore lint/performance/noAwaitInLoops: polls until the test run has started its own process
    while (!(await Bun.file(`${dir}/pids`).exists()) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    const pids = (await Bun.file(`${dir}/pids`).text()).split(" ").map(Number);
    child.kill("SIGTERM");
    await child.exited;
    await Bun.sleep(300);
    const running = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    for (const pid of running) {
      process.kill(pid, "SIGKILL");
    }
    expect(running).toEqual([]);
    expect(await mathNow()).toBe(source);
  });

  test("a process the tests leave running is stopped when they finish", async () => {
    await Bun.write(
      `${dir}/math.test.ts`,
      `${spec}test("leaves a process", async () => {
  const sleeper = Bun.spawn(["sleep", "30"]);
  sleeper.unref();
  await Bun.write("pids", String(sleeper.pid));
});\n`
    );
    const result = await run([
      "math.ts",
      "n * 2",
      "n * 3",
      "--",
      "./math.test.ts",
    ]);
    expect(result.out).toStartWith("RED");
    const pid = Number(await Bun.file(`${dir}/pids`).text());
    await Bun.sleep(200);
    let running = true;
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      running = false;
    }
    expect(running).toBe(false);
  });

  test("text that looks like --help is flipped, not taken for the option", async () => {
    await Bun.write(
      `${dir}/math.ts`,
      `${source}export const flag = "--help";\n`
    );
    const result = await run([
      "math.ts",
      "--help",
      "--hulp",
      "--",
      "./math.test.ts",
    ]);
    expect(result.out).toStartWith("GREEN");
  });

  test("a flip killed outright is put back by the next flip, which then runs", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const flipped = source.replace("n * 2", "n * 3");
    await Bun.write(`${dir}/math.ts`, flipped);
    await leaveState({ flipped, original: source, pid: dead.pid });
    const result = await run([
      "math.ts",
      "=> 1",
      "=> 2",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toContain("put back");
    expect(result.out).toStartWith("GREEN");
    expect(await mathNow()).toBe(source);
  });

  test("a killed flip whose file was edited since is not overwritten, exit 2", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const flipped = source.replace("n * 2", "n * 3");
    const edited = `${flipped}// my own edit\n`;
    await Bun.write(`${dir}/math.ts`, edited);
    await leaveState({ flipped, original: source, pid: dead.pid });
    const result = await run([
      "math.ts",
      "=> 1",
      "=> 2",
      "--",
      "./math.test.ts",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(".flip.json");
    expect(await mathNow()).toBe(edited);
  });

  test("a second flip while one runs is refused, so neither run sees the other's flip", async () => {
    await leaveState({ flipped: source, original: source, pid: process.pid });
    const result = await run([
      "math.ts",
      "n * 2",
      "n * 3",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toContain("another flip");
    expect(result.code).toBe(2);
    expect(await mathNow()).toBe(source);
  });
});

describe("a sweep", () => {
  const base = `export const adult = (age: number) => age >= 18;
export const half = (n: number) => n / 2;
`;
  // Two lines added since main, above an unchanged line with an operator: the boundary is pinned on both sides, the count is not.
  const changed = `export const senior = (age: number) => age >= 65;
export const count = (n: number) => n + 1;
export const adult = (age: number) => age >= 18;
export const half = (n: number) => n / 2;
`;
  const sweepSpec = `import { expect, test } from "bun:test";
import { adult, count, senior } from "./math.ts";
test("adult at 18, not at 17", () => { expect(adult(18)).toBe(true); expect(adult(17)).toBe(false); });
test("senior at 65, not at 64", () => { expect(senior(65)).toBe(true); expect(senior(64)).toBe(false); });
test("count is a number", () => { expect(typeof count(1)).toBe("number"); });
`;

  beforeEach(async () => {
    await Bun.write(`${dir}/math.ts`, base);
    await Bun.$`git init -q -b main && git add math.ts && git -c user.email=t@t -c user.name=t commit -qm base`
      .cwd(dir)
      .quiet();
    await Bun.write(`${dir}/math.ts`, changed);
    await Bun.write(`${dir}/math.test.ts`, sweepSpec);
  });

  test("flips only the lines changed since main, counts the mutants and prints each survivor, exit 1", async () => {
    const result = await run(["--sweep", "math.ts", "--", "./math.test.ts"]);
    expect(result.out).toStartWith(
      "math.ts since main: 2 mutants, 1 red, 1 survived, 0 no verdict"
    );
    expect(result.out).toContain(
      "2: export const count = (n: number) => n + 1; ==> export const count = (n: number) => n - 1;"
    );
    expect(result.out).not.toContain("3: ");
    expect(result.out).not.toContain("no verdict:");
    expect(result.code).toBe(1);
    expect(await mathNow()).toBe(changed);
    expect(await Bun.file(`${dir}/.flip.json`).exists()).toBe(false);
  });

  test("--since names the base, so lines changed after it alone are flipped", async () => {
    await Bun.$`git checkout -qb work && git add math.ts && git -c user.email=t@t -c user.name=t commit -qm next`
      .cwd(dir)
      .quiet();
    const result = await run([
      "--sweep",
      "math.ts",
      "--since",
      "HEAD",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toContain("no line of math.ts changed since HEAD");
    expect(result.code).toBe(2);
  });

  test("every mutant red is exit 0", async () => {
    await Bun.write(
      `${dir}/math.test.ts`,
      `${sweepSpec}test("count adds one", () => { expect(count(1)).toBe(2); });\n`
    );
    const result = await run(["--sweep", "math.ts", "--", "./math.test.ts"]);
    expect(result.out).toStartWith(
      "math.ts since main: 2 mutants, 2 red, 0 survived"
    );
    expect(result.code).toBe(0);
  });

  test("a mutant that hangs is killed at the deadline and counted as no verdict, and the sweep goes on", async () => {
    const looping = `${changed}export function steps(): number { let i = 0; for (let n = 0; n < 3; n = n + 1) { i++; } return i; }\n`;
    await Bun.write(`${dir}/math.ts`, looping);
    await Bun.write(
      `${dir}/math.test.ts`,
      `${sweepSpec.replace("import { adult, count, senior }", "import { adult, count, senior, steps }")}test("three steps", () => { expect(steps()).toBe(3); });\n`
    );
    const result = await run(["--sweep", "math.ts", "--", "./math.test.ts"], {
      FLIP_TIMEOUT_MS: "1500",
    });
    expect(result.out).toContain("1 no verdict");
    expect(result.out).toContain("ran past 1.5 s");
    expect(await mathNow()).toBe(looping);
  });

  test("a file git does not track yet is swept whole", async () => {
    await Bun.write(
      `${dir}/extra.ts`,
      "export const both = (a: boolean, b: boolean) => a && b;\nexport const big = (n: number) => n >= 10;\n"
    );
    const result = await run(["--sweep", "extra.ts", "--", "./math.test.ts"]);
    expect(result.out).toStartWith(
      "extra.ts, not tracked by git, every line: 2 mutants, 0 red, 2 survived"
    );
    expect(result.code).toBe(1);
  });

  test("a file outside the repository is not applied, exit 2, in one line", async () => {
    const other = (await Bun.$`mktemp -d`.text()).trim();
    await Bun.write(
      `${other}/lib.ts`,
      "export const f = (a: number) => a > 0;\n"
    );
    const result = await run([
      "--sweep",
      `${other}/lib.ts`,
      "--",
      "./math.test.ts",
    ]);
    await Bun.$`rm -rf ${other}`.quiet();
    expect(result.err).toBe(
      `NOT APPLIED: ${other}/lib.ts is outside the repository at ${dir}\n`
    );
    expect(result.code).toBe(2);
  });

  test("--since a ref that does not exist names it, exit 2", async () => {
    const result = await run([
      "--sweep",
      "math.ts",
      "--since",
      "nosuchref",
      "--",
      "./math.test.ts",
    ]);
    expect(result.err).toBe("NOT APPLIED: git knows no ref nosuchref\n");
    expect(result.code).toBe(2);
  });

  test("a flip from a subfolder sees a flip running from the repository root", async () => {
    await Bun.$`mkdir -p sub`.cwd(dir).quiet();
    await leaveState({ flipped: changed, original: changed, pid: process.pid });
    const child = Bun.spawn(
      [
        "bun",
        flipScript,
        "../math.ts",
        "n + 1",
        "n - 1",
        "--",
        "../math.test.ts",
      ],
      {
        cwd: `${dir}/sub`,
        stderr: "pipe",
      }
    );
    expect(await new Response(child.stderr).text()).toContain("another flip");
    expect(await child.exited).toBe(2);
  });

  test("SIGTERM during a sweep puts the source back", async () => {
    await Bun.write(
      `${dir}/math.test.ts`,
      `${sweepSpec}test("slow", async () => { await Bun.sleep(20_000); }, 30_000);\n`
    );
    const child = flip(["--sweep", "math.ts", "--", "./math.test.ts"]);
    const deadline = Date.now() + 10_000;
    // biome-ignore lint/performance/noAwaitInLoops: polls until a mutant is on disk
    while ((await mathNow()) === changed && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(2);
    expect(await mathNow()).toBe(changed);
    expect(await Bun.file(`${dir}/.flip.json`).exists()).toBe(false);
  });
});
