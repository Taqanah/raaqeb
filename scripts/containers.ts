/**
 * What the checks that run containers share: a free port, a command run with
 * its exit code and output, polling until something holds, and waiting for a
 * browser page to reach a path. Not a check itself.
 */
import type { Page } from "@playwright/test";

/** A port nothing listens on, from the kernel. */
export function freePort(): number {
  const held = Bun.serve({ fetch: () => new Response(), port: 0 });
  const { port } = held;
  held.stop(true);
  return port ?? 0;
}

/** Runs a command and answers its exit code and output, never throwing. */
export async function run(
  command: string[]
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, output: stdout + stderr };
}

export async function must(command: string[]): Promise<string> {
  const { code, output } = await run(command);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited ${code}: ${output}`);
  }
  return output.trim();
}

/** Polls until the check answers true, or throws naming what never happened. */
export async function until(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling, one attempt at a time
    if (await check().catch(() => false)) {
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function expectPath(page: Page, path: string): Promise<void> {
  await until(`the page at ${path}`, () =>
    Promise.resolve(new URL(page.url()).pathname === path)
  );
}
