/**
 * `bun run image:check`: the check of the image `bun run image` loaded. A
 * container on an empty named volume serves the onboarding page; a headless
 * browser walks onboarding to the empty monitors list; `raaqeb health` inside
 * the container then exits 0 and Docker's own health check reads healthy; an
 * email channel's test message leaves the binary over SMTP, a real send;
 * `raaqeb reset-password` beside the server prints a link; `docker stop` ends
 * it with exit code 0. Needs Docker and Playwright's Chromium, so it stays
 * out of the gate. The container shares the host's network, so it reaches the
 * scripted SMTP server on loopback.
 */
import { chromium } from "@playwright/test";
import { fakeSmtp } from "@/server/notify/fixture.ts";
import { expectPath, freePort, must, run, until } from "./containers.ts";
import { imageTag, releaseVersion } from "./package.ts";

const repo = `${import.meta.dir}/..`;
const version = releaseVersion(await Bun.file(`${repo}/package.json`).json());
const image = imageTag(version);
const name = `raaqeb-check-${Date.now().toString(36)}`;
const continueButton = "form button[type=submit]";

function step(line: string): void {
  process.stdout.write(`image:check: ${line}\n`);
}

const port = freePort();
const origin = `http://127.0.0.1:${port}`;
const smtp = fakeSmtp();
const browser = await chromium.launch();
let failed = false;
try {
  await must(["docker", "volume", "create", name]);
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
    `${name}:/data`,
    image,
  ]);
  step(`started ${image} on an empty volume`);

  const page = await browser.newPage();
  await until("the onboarding page", async () => {
    const response = await fetch(`${origin}/onboarding`);
    return response.status === 200;
  });
  await page.goto(`${origin}/`);
  await expectPath(page, "/onboarding");
  step("reached the onboarding page");
  await page.click(continueButton);
  await expectPath(page, "/onboarding/database");
  await page.click(continueButton);
  await expectPath(page, "/onboarding/account");
  await page.fill("input[name=email]", "operator@example.com");
  await page.fill("input[name=password]", "correct horse battery");
  await page.click(continueButton);
  await expectPath(page, "/admin/monitors");
  step("walked onboarding to the monitors list");

  await must(["docker", "exec", name, "raaqeb", "health"]);
  step("raaqeb health exited 0");
  await until(
    "Docker's health check to read healthy",
    async () =>
      (await must([
        "docker",
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        name,
      ])) === "healthy"
  );
  step("Docker reads the container healthy");

  await page.goto(`${origin}/admin/channels/new`);
  await page.click("[role=radio][data-value=email]");
  const form = page.locator("[data-slot=channel-form]");
  await form.locator("input[name=name]").fill("Mail");
  await form.locator("input[name=from]").fill("raaqeb@example.com");
  await form.locator("input[name=to]").fill("team@example.com");
  await form.locator("input[name=host]").fill("127.0.0.1");
  await form.locator("select[name=security]").selectOption("none");
  await form.locator("input[name=port]").fill(String(smtp.port));
  await form.locator("button[type=submit]").click();
  await until("the saved channel's page", () =>
    Promise.resolve(new URL(page.url()).pathname !== "/admin/channels/new")
  );
  await page.click("[data-slot=send-test]");
  await until("the test message over SMTP", () =>
    Promise.resolve(smtp.messages.length === 1)
  );
  step("the email channel's test message left over SMTP");

  const reset = await must([
    "docker",
    "exec",
    name,
    "raaqeb",
    "reset-password",
  ]);
  if (!reset.includes(`${origin}/`)) {
    throw new Error(`reset-password printed no link: ${reset}`);
  }
  step("raaqeb reset-password printed a reset link");

  await must(["docker", "stop", name]);
  const exit = await must([
    "docker",
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    name,
  ]);
  if (exit !== "0") {
    throw new Error(`docker stop ended raaqeb with exit code ${exit}`);
  }
  step("docker stop ended raaqeb with exit code 0");
} catch (error) {
  failed = true;
  process.stderr.write(`image:check failed: ${String(error)}\n`);
  const logs = await run(["docker", "logs", name]);
  process.stderr.write(logs.output);
} finally {
  await browser.close();
  smtp.stop();
  await run(["docker", "rm", "-f", name]);
  await run(["docker", "volume", "rm", name]);
}
process.exit(failed ? 1 : 0);
