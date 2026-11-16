import { describe, expect, test } from "bun:test";
import { busyPortMessage, checkoutFirstPort, firstPort } from "./e2e-ports.ts";

const common = "/home/someone/raaqeb/.git";

/** The ports compose.yaml publishes on the host: a derived block must never take one. */
async function composePorts(): Promise<number[]> {
  const compose = await Bun.file(`${import.meta.dir}/../compose.yaml`).text();
  return [...compose.matchAll(/"127\.0\.0\.1:(\d+):/g)].map((m) =>
    Number(m[1])
  );
}

describe("the e2e run's ports", () => {
  test("start at 3210 in the repository's main checkout", () => {
    expect(firstPort(common, common)).toBe(3210);
  });

  test("a linked worktree takes five of its own, clear of the main checkout's", () => {
    const first = firstPort(`${common}/worktrees/second`, common);
    expect(first).toBeGreaterThanOrEqual(10_000);
    expect(first + 4).toBeLessThan(32_768);
  });

  test("a worktree's rerun takes the same ports, and two worktrees take different ones", () => {
    const second = firstPort(`${common}/worktrees/second`, common);
    expect(firstPort(`${common}/worktrees/second`, common)).toBe(second);
    expect(firstPort(`${common}/worktrees/third`, common)).not.toBe(second);
  });

  test("no worktree's five ports take a port the compose services publish", async () => {
    const published = await composePorts();
    expect(published).toContain(27_017);
    for (let i = 0; i < 20_000; i += 1) {
      const first = firstPort(`${common}/worktrees/w${i}`, common);
      for (const port of published) {
        expect(port >= first && port <= first + 4).toBe(false);
      }
    }
  });

  test("RAAQEB_E2E_PORT sets the first port, in any checkout", () => {
    expect(checkoutFirstPort({ RAAQEB_E2E_PORT: "40000" })).toBe(40_000);
  });

  test("a RAAQEB_E2E_PORT that is not a port is refused, naming the variable", () => {
    expect(() => checkoutFirstPort({ RAAQEB_E2E_PORT: "abc" })).toThrow(
      "RAAQEB_E2E_PORT"
    );
    expect(() => checkoutFirstPort({ RAAQEB_E2E_PORT: "65533" })).toThrow(
      "RAAQEB_E2E_PORT"
    );
  });

  test("with no git on PATH the ports are the main checkout's", () => {
    const run = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { checkoutFirstPort } from "${import.meta.dir}/e2e-ports.ts"; console.log(checkoutFirstPort({}));`,
      ],
      { env: { PATH: "/nonexistent" } }
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString().trim()).toBe("3210");
  });

  test("a taken port is named in one line with the variable that moves the run", () => {
    const held = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    try {
      const message = busyPortMessage(held.port) ?? "";
      expect(message).toContain(`port ${held.port} is in use`);
      expect(message).toContain("RAAQEB_E2E_PORT");
      expect(message).not.toContain("\n");
    } finally {
      held.stop(true);
    }
  });
});
