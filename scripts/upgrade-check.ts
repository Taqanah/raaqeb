/**
 * `bun run upgrade:check <from-image> [<to-image>]`: an install that holds
 * data survives the upgrade from one image to the next, on SQLite and on
 * Postgres. The old image starts on an empty volume (and an empty Postgres),
 * a headless browser walks onboarding and sets up the authenticator app, and
 * the seed is restored through the import route: a monitor of every check
 * type and a channel of every kind, with history, outages, sealed days,
 * status pages, an incident, a maintenance window, subscribers and settings.
 * The export the old version writes is kept. The old image stops, the new one
 * starts on the same data, and the operator signs in with the password and
 * the app's code, then with a backup code. The export the new version writes
 * must differ from the old one in nothing, and a start after it must find
 * nothing to migrate. The to-image is the one `bun run image` loads for this
 * checkout unless given. `--without=docker,ntfy` leaves out the check types
 * and channel kinds the old image does not know; `--seed=<file>` restores an
 * export the old image can read in place of the built-in seed, for a release
 * whose export format the built-in seed does not match. Needs Docker and Playwright's Chromium, so it stays
 * out of the gate. The containers share the host's network.
 */
import { chromium, type Page } from "@playwright/test";
import { appCode } from "@/server/auth/fixture.ts";
import { linesOf } from "@/server/export/fixture.ts";
import { importAnswerSchema } from "@/shared/schemas/export.ts";
import { expectPath, freePort, must, run, until } from "./containers.ts";
import { imageTag, releaseVersion } from "./package.ts";
import {
  differences,
  type ExportLine,
  inventory,
  migrationNote,
  migrationProblems,
} from "./upgrade-check-export.ts";
import { seedFile } from "./upgrade-check-seed.ts";

const repo = `${import.meta.dir}/..`;
const args = Bun.argv.slice(2);
const [named, given] = args.filter((arg) => !arg.startsWith("--"));
/** The value of a `--name=value` flag. */
const flag = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
// A release that lacks a check type or a channel kind cannot restore a seed that holds it.
const without = flag("without")?.split(",") ?? [];
const seedPath = flag("seed");
if (named === undefined) {
  process.stderr.write(
    "usage: bun run upgrade:check <from-image> [<to-image>] [--without=<type>,...] [--seed=<export file>]\n"
  );
  process.exit(2);
}
const from: string = named;
const to: string =
  given ??
  imageTag(releaseVersion(await Bun.file(`${repo}/package.json`).json()));

const tag = Date.now().toString(36);
const email = "operator@example.com";
const password = "correct horse battery";
const continueButton = "form button[type=submit]";
/** The compose file's Postgres, so the check runs against what operators run. */
const postgresImage = "postgres:18.6-alpine";
/** The import answers after its sealing pass, which Bun's idle timeout would cut at ten seconds. */
const importWithinMs = 255_000;

const containers: string[] = [];
const volumes: string[] = [];

type Backend = "postgres" | "sqlite";

interface Running {
  readonly name: string;
  readonly origin: string;
}

function say(backend: Backend, line: string): void {
  process.stdout.write(`upgrade:check: ${backend}: ${line}\n`);
}

function counts(lines: readonly ExportLine[]): string {
  return Object.entries(inventory(lines))
    .map(([table, size]) => `${size} ${table}`)
    .join(", ");
}

async function startPostgres(base: string): Promise<string> {
  const port = freePort();
  const name = `${base}-db`;
  containers.push(name);
  await must([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "host",
    "--tmpfs",
    "/var/lib/postgresql",
    "-e",
    "POSTGRES_USER=raaqeb",
    "-e",
    "POSTGRES_PASSWORD=raaqeb",
    "-e",
    "POSTGRES_DB=raaqeb",
    postgresImage,
    "-c",
    `port=${port}`,
    "-c",
    "listen_addresses=127.0.0.1",
  ]);
  // Over TCP, so the server that only runs the image's init scripts does not answer.
  await until("Postgres", async () => {
    const { code } = await run([
      "docker",
      "exec",
      name,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "raaqeb",
      "-d",
      "raaqeb",
    ]);
    return code === 0;
  });
  return `postgres://raaqeb:raaqeb@127.0.0.1:${port}/raaqeb`;
}

/** One container of the backend's install; the port stays the same through the upgrade, as the public address the install stored at onboarding names it. */
async function start(
  base: string,
  image: string,
  role: string,
  port: number
): Promise<Running> {
  const name = `${base}-${role}`;
  containers.push(name);
  await must([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "host",
    "-e",
    "RAAQEB_HOST=127.0.0.1",
    "-e",
    `RAAQEB_PORT=${port}`,
    "-v",
    `${base}:/data`,
    image,
  ]);
  const origin = `http://127.0.0.1:${port}`;
  await until(`${role} to answer /health`, async () => {
    const response = await fetch(`${origin}/health`);
    return response.ok;
  });
  return { name, origin };
}

async function stop(name: string): Promise<void> {
  await must(["docker", "stop", name]);
  const exit = await must([
    "docker",
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    name,
  ]);
  if (exit !== "0") {
    throw new Error(`docker stop ended ${name} with exit code ${exit}`);
  }
}

async function logOf(name: string): Promise<string> {
  return (await run(["docker", "logs", name])).output;
}

/** Walks onboarding on a fresh install to the monitors list, signed in. */
async function onboard(
  page: Page,
  origin: string,
  databaseUrl: string | undefined
): Promise<void> {
  await page.goto(`${origin}/`);
  await expectPath(page, "/onboarding");
  await page.click(continueButton);
  await expectPath(page, "/onboarding/database");
  if (databaseUrl !== undefined) {
    await page.click(
      "[role=radiogroup][data-name=backend] [role=radio][data-value=postgres]"
    );
    await page.fill("input[name=url]", databaseUrl);
    await page.click("button[name=test]");
    await page.locator("[data-verdict=empty]").waitFor();
  }
  await page.click(continueButton);
  await expectPath(page, "/onboarding/account");
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click(continueButton);
  await expectPath(page, "/admin/monitors");
}

/** Sets up the authenticator app, which turns the second step on, and answers its key as a URI and the first backup code. */
async function setUpAuthenticator(
  page: Page,
  origin: string
): Promise<{ backup: string; uri: string }> {
  await page.goto(`${origin}/admin/settings/sign-in`);
  const app = page.locator("[data-slot=authenticator-form][data-app=false]");
  await app.locator("input[name=password]").fill(password);
  await app.locator("button[type=submit]").click();
  const key = await page.locator("[data-slot=authenticator-key]").innerText();
  const uri = `otpauth://totp/x?secret=${key.replaceAll(" ", "")}`;
  await page.fill(
    "[data-slot=authenticator-scan] input[name=code]",
    appCode(uri)
  );
  await page.click("[data-slot=authenticator-scan] button[type=submit]");
  const shown = page.locator("[data-slot=backup-code]");
  await shown.first().waitFor();
  const [backup] = await shown.allInnerTexts();
  await page.click("[data-slot=backup-codes-done]");
  await page.locator("[data-slot=second-step-form][data-on=true]").waitFor();
  if (backup === undefined) {
    throw new Error("the authenticator setup showed no backup codes");
  }
  return { backup, uri };
}

/** Signs in with the password and then the code, the app's or a backup one. */
async function signIn(
  page: Page,
  origin: string,
  code: { backup: string } | { uri: string }
): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", password);
  await page.click(continueButton);
  const form = page.locator("[data-slot=code-form]");
  await form.waitFor();
  if ("backup" in code) {
    await page.click("[data-slot=use-backup]");
    await page.locator("[data-slot=code-form][data-method=backup]").waitFor();
    await page.fill("input[name=code]", code.backup);
  } else {
    await page.locator("[data-slot=code-form][data-method=app]").waitFor();
    await page.fill("input[name=code]", appCode(code.uri));
  }
  await page.click("[data-slot=code-form] button[type=submit]");
  await expectPath(page, "/admin/monitors");
}

async function importSeed(
  page: Page,
  origin: string,
  seed: Uint8Array
): Promise<string> {
  const response = await page.request.post(`${origin}/admin/import`, {
    data: Buffer.from(seed),
    headers: { origin },
    timeout: importWithinMs,
  });
  const answer = importAnswerSchema.parse(await response.json());
  if (!answer.ok) {
    throw new Error(
      `the old version refused the seed: ${answer.reason}${answer.line === undefined ? "" : ` at line ${answer.line}`}`
    );
  }
  return `${answer.monitors} monitors, ${answer.pages} pages, ${answer.records} records of history`;
}

async function exportOf(page: Page, origin: string): Promise<ExportLine[]> {
  const response = await page.request.get(`${origin}/admin/export?mode=full`, {
    timeout: importWithinMs,
  });
  if (response.headers()["content-type"] !== "application/zstd") {
    throw new Error(
      `the export answered ${response.status()} at ${response.url()}`
    );
  }
  return await linesOf(
    new Blob([Uint8Array.from(await response.body())]).stream()
  );
}

/** One backend through the whole upgrade; throws at the first thing that does not hold. */
async function checkBackend(
  backend: Backend,
  seed: Uint8Array,
  open: () => Promise<Page>
): Promise<void> {
  const base = `raaqeb-upgrade-${tag}-${backend}`;
  await must(["docker", "volume", "create", base]);
  volumes.push(base);
  const databaseUrl =
    backend === "postgres" ? await startPostgres(base) : undefined;
  const port = freePort();

  const old = await start(base, from, "from", port);
  say(backend, `started ${from} on an empty ${backend} install`);
  const page = await open();
  await onboard(page, old.origin, databaseUrl);
  const { backup, uri } = await setUpAuthenticator(page, old.origin);
  say(backend, "walked onboarding and set up the authenticator app");
  say(
    backend,
    `restored the seed: ${await importSeed(page, old.origin, seed)}`
  );
  const before = await exportOf(page, old.origin);
  say(backend, `the old version holds ${counts(before)}`);
  await stop(old.name);

  const upgraded = await start(base, to, "to", port);
  say(backend, `started ${to} on the same data`);
  await must(["docker", "exec", upgraded.name, "raaqeb", "health"]);
  const session = await open();
  await signIn(session, upgraded.origin, { uri });
  say(backend, "the operator signed in with the password and the app's code");
  await signIn(await open(), upgraded.origin, { backup });
  say(backend, "the operator signed in with the password and a backup code");
  const after = await exportOf(session, upgraded.origin);
  const found = differences(before, after);
  if (found.length > 0) {
    throw new Error(
      `the upgrade changed the install:\n- ${found.join("\n- ")}`
    );
  }
  say(
    backend,
    "the new version's export differs from the old one's in nothing"
  );
  await stop(upgraded.name);

  const again = await start(base, to, "again", port);
  await stop(again.name);
  const first = await logOf(upgraded.name);
  const problems = migrationProblems(first, await logOf(again.name));
  if (problems.length > 0) {
    throw new Error(
      `the migrations did not run once:\n- ${problems.join("\n- ")}`
    );
  }
  const note = migrationNote(first);
  say(
    backend,
    `the migrations ran once (${note?.applied} applied, version ${note?.from} to ${note?.to}) and the next start found nothing to do`
  );
}

const browser = await chromium.launch();
let failed = false;
try {
  const seed =
    seedPath === undefined
      ? await seedFile(Date.now(), without)
      : await Bun.file(seedPath).bytes();
  if (without.length > 0) {
    process.stdout.write(
      `upgrade:check: the seed holds no ${without.join(", ")}\n`
    );
  }
  for (const backend of ["sqlite", "postgres"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: one backend at a time, each owns its volume and containers
    await checkBackend(backend, seed, async () => {
      const context = await browser.newContext();
      return await context.newPage();
    });
  }
  process.stdout.write(
    `upgrade:check: ${from} to ${to} passed on sqlite and postgres\n`
  );
} catch (error) {
  failed = true;
  process.stderr.write(`upgrade:check failed: ${String(error)}\n`);
  for (const name of containers) {
    // biome-ignore lint/performance/noAwaitInLoops: the logs print in order
    process.stderr.write(`--- ${name}\n${await logOf(name)}`);
  }
} finally {
  await browser.close();
  await Promise.all(
    containers.map((name) => run(["docker", "rm", "-f", "-v", name]))
  );
  await Promise.all(
    volumes.map((name) => run(["docker", "volume", "rm", name]))
  );
}
process.exit(failed ? 1 : 0);
