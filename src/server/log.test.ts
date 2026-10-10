import { describe, expect, test } from "bun:test";
import { loggedPath, reasonOf } from "./log.ts";

/** Runs a snippet against the log module in a child so both streams can be read whole. */
async function run(
  snippet: string
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import { info, error } from "./src/server/log.ts"; ${snippet}`,
    ],
    { cwd: `${import.meta.dir}/../..`, stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { stderr, stdout };
}

describe("the logging convention", () => {
  test("an event is one plain line on standard output and an error one on standard error, each named by the program", async () => {
    expect(
      await run('info("listening"); error("no server build found")')
    ).toEqual({
      stderr: "raaqeb: no server build found\n",
      stdout: "raaqeb: listening\n",
    });
  });

  test("a line holding line breaks, as an error's message may, is still one line", async () => {
    expect(await run('info("a\\n  b"); error("c\\r\\n\\nd")')).toEqual({
      stderr: "raaqeb: c d\n",
      stdout: "raaqeb: a b\n",
    });
  });

  test("lines keep their order within a stream", async () => {
    expect((await run('info("a"); info("b")')).stdout).toBe(
      "raaqeb: a\nraaqeb: b\n"
    );
  });
});

describe("a request's path in a line", () => {
  test("a heartbeat token, the only key to its monitor, is masked", () => {
    expect(
      loggedPath("http://127.0.0.1:3000/api/heartbeat/hb_live_secret?x=1")
    ).toBe("/api/heartbeat/<token>");
  });

  test("a subscription's token is masked on its page, confirm and unsubscribe", () => {
    expect(loggedPath("http://h/subscriptions/sub_secret")).toBe(
      "/subscriptions/<token>"
    );
    expect(loggedPath("http://h/subscriptions/sub_secret/confirm")).toBe(
      "/subscriptions/<token>/confirm"
    );
    expect(loggedPath("http://h/subscriptions/sub_secret/unsubscribe")).toBe(
      "/subscriptions/<token>/unsubscribe"
    );
  });

  test("a password reset token in Better Auth's callback path is masked", () => {
    expect(loggedPath("http://h/api/auth/reset-password/reset_secret")).toBe(
      "/api/auth/reset-password/<token>"
    );
  });

  test("any other path is kept whole, without its query", () => {
    expect(loggedPath("http://h/_serverFn/abc?token=secret")).toBe(
      "/_serverFn/abc"
    );
    expect(loggedPath("http://h/api/heartbeat")).toBe("/api/heartbeat");
    expect(loggedPath("http://h/status/main/subscriptions")).toBe(
      "/status/main/subscriptions"
    );
  });
});

describe("an error's reason in a line", () => {
  test("a refused query is its driver's reason, never the values it was bound to", () => {
    const refused = new Error(
      "Failed query: INSERT INTO captures VALUES (?)\nparams: s3cret-token",
      { cause: new Error("FOREIGN KEY constraint failed") }
    );
    expect(reasonOf(refused)).toBe("FOREIGN KEY constraint failed");
  });

  test("a refused query without a driver reason is named by its class, still without the values", () => {
    const refused = new Error("Failed query: SELECT 1\nparams: s3cret-token");
    refused.name = "DrizzleQueryError";
    expect(reasonOf(refused)).toBe("DrizzleQueryError");
  });

  test("any other error keeps its message", () => {
    expect(reasonOf(new Error("database gone"))).toBe("database gone");
    expect(reasonOf("text")).toBe("an error that is not an Error");
  });
});
