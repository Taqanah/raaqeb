import { defineConfig, devices } from "@playwright/test";
import {
  arabicOrigin,
  arabicPort,
  emptyOrigin,
  emptyPort,
  englishOrigin,
  englishPort,
  freshOrigin,
  freshPort,
  sinkOrigin,
  sinkPort,
} from "./e2e/support/servers.ts";

// The specs run against the built app on the Bun.serve entry, not the Vite dev
// server, because the entry is product code and the dev server is not. Four
// servers: the Arabic default, which stays in onboarding; an install seeded
// with English and an operator account, so the document can be seen to follow
// the settings and the specs can sign in; and a fresh install for the
// onboarding walk, and an empty install with its account for the export
// spec to import into. Beside them, a webhook receiver for the channels spec.

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: true,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: "list",
  // A retry would hide the intermittent bugs the suite exists to find.
  retries: 0,
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: arabicOrigin },
  webServer: [
    {
      // The data directory is wiped so the server starts in onboarding every run.
      command:
        "rm -rf test-results/data && bun run build && bun dist/server/server.js",
      // The data directory lands under Playwright's output folder, never in ./data.
      env: {
        RAAQEB_DATA_DIR: "test-results/data",
        RAAQEB_HOST: "127.0.0.1",
        RAAQEB_PORT: String(arabicPort),
      },
      name: "arabic",
      // A stale server on the port would test an old build; fail instead.
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 120_000,
      url: `${arabicOrigin}/`,
    },
    {
      command: `bun e2e/support/serve-fresh.ts ${arabicOrigin} ${freshPort} test-results/data-fresh`,
      name: "fresh",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 150_000,
      url: `${freshOrigin}/`,
    },
    {
      command: `bun e2e/support/serve-en.ts ${arabicOrigin} ${englishPort} test-results/data-en`,
      name: "english",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 150_000,
      url: `${englishOrigin}/`,
    },
    {
      command: `bun e2e/support/serve-empty.ts ${arabicOrigin} ${emptyPort} test-results/data-empty`,
      name: "empty",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 150_000,
      url: `${emptyOrigin}/`,
    },
    {
      command: `bun e2e/support/sink.ts ${sinkPort}`,
      name: "sink",
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 30_000,
      url: `${sinkOrigin}/received`,
    },
  ],
});
