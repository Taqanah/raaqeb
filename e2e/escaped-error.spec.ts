// An error that escapes Start's handler is one line through src/server/log.ts,
// never h3's multi-line stack with the install's absolute paths. It shows on the built server only, so each test runs its own.

import { expect, test } from "./support/fixtures.ts";
import { spawnInstall } from "./support/spawn.ts";

/** Runs the built server in onboarding on an install of its own and answers what it wrote to standard error, a line each. */
async function stderrOf(
  body: (origin: string) => Promise<void>
): Promise<string[]> {
  const install = await spawnInstall();
  let lines: string[] = [];
  try {
    await body(install.origin);
  } finally {
    lines = await install.stop();
  }
  return lines;
}

test("a server function call no handler knows writes one line to standard error, with no absolute path, and answers 500", async () => {
  const lines = await stderrOf(async (origin) => {
    // The query never reaches the line, so a token in it stays out of the log.
    const response = await fetch(
      `${origin}/_serverFn/not-a-registered-id?token=secret`,
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "x-tsr-serverfn": "true",
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: "HTTPError",
      status: 500,
      unhandled: true,
    });
  });
  expect(lines).toEqual([
    "raaqeb: the request POST /_serverFn/not-a-registered-id failed: Server function info not found for not-a-registered-id",
  ]);
  expect(lines.join("\n")).not.toContain(process.cwd());
});

test("a server function call the browser abandons by navigating away writes nothing to standard error", async ({
  page,
}) => {
  // A database that accepts the connection and never answers holds the connection test open.
  const silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  try {
    const lines = await stderrOf(async (origin) => {
      await page.goto(`${origin}/onboarding/database`);
      await page.click(
        "[role=radiogroup][data-name=backend] [role=radio][data-value=postgres]"
      );
      await page.fill(
        "input[name=url]",
        `postgres://u:p@127.0.0.1:${silent.port}/raaqeb`
      );
      await Promise.all([
        page.waitForRequest((request) => request.url().includes("/_serverFn/")),
        page.click("button[name=test]"),
      ]);
      await page.goto(`${origin}/onboarding`);
      // Bun sees the closed connection and aborts the request's signal.
      await Bun.sleep(1000);
    });
    expect(lines).toEqual([]);
  } finally {
    silent.stop(true);
  }
});
