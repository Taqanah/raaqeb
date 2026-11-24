import { expect, test } from "bun:test";
import { machines, refusal } from "./install-check.ts";

/** The Dockerfile line that masks units. */
const maskLine = /^RUN systemctl mask (.+)$/m;

function machine(name: string) {
  const found = machines.find((each) => each.name === name);
  if (!found) {
    throw new Error(`no machine ${name}`);
  }
  return found;
}

test("the privileged Debian machine masks every unit that would take a terminal or the host's devices", () => {
  const masked = maskLine.exec(machine("debian").dockerfile)?.[1]?.split(" ");
  expect(masked).toEqual(
    expect.arrayContaining([
      "getty.target",
      "getty@.service",
      "getty@tty1.service",
      "autovt@.service",
      "console-getty.service",
      "systemd-logind.service",
      "systemd-udevd.service",
      "systemd-udev-trigger.service",
      "systemd-vconsole-setup.service",
    ])
  );
});

test("a privileged machine is refused off a GitHub runner, saying why, and runs on one", () => {
  const debian = machine("debian");
  expect(debian.runFlags).toContain("--privileged");
  expect(refusal(debian, {})).toContain("the host's devices");
  expect(refusal(debian, { GITHUB_ACTIONS: "false" })).toContain(
    "GITHUB_ACTIONS"
  );
  expect(refusal(debian, { GITHUB_ACTIONS: "true" })).toBeUndefined();
});

test("a privileged machine is refused under act, which sets GITHUB_ACTIONS=true on a desktop", () => {
  expect(
    refusal(machine("debian"), { ACT: "true", GITHUB_ACTIONS: "true" })
  ).toContain("the host's devices");
});

test("an unprivileged machine runs anywhere", () => {
  const alpine = machine("alpine");
  expect(alpine.runFlags).not.toContain("--privileged");
  expect(refusal(alpine, {})).toBeUndefined();
});
