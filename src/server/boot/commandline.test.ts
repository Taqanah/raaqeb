import { describe, expect, test } from "bun:test";
import { parseCommandLine } from "./commandline.ts";

function accepted(args: string[]) {
  const line = parseCommandLine(args);
  if (!line.ok) {
    throw new Error(`expected an accepted command line: ${line.message}`);
  }
  return line;
}

function refused(args: string[]): string {
  const line = parseCommandLine(args);
  if (line.ok) {
    throw new Error("expected a refused command line");
  }
  return line.message;
}

describe("the reset command's flag", () => {
  test("--interactive is accepted with reset-password", () => {
    expect(accepted(["reset-password", "--interactive"])).toEqual({
      command: "reset-password",
      flags: {},
      interactive: true,
      ok: true,
    });
    expect(
      accepted(["--interactive", "reset-password", "--data-dir", "/d"])
    ).toEqual({
      command: "reset-password",
      flags: { RAAQEB_DATA_DIR: "/d" },
      interactive: true,
      ok: true,
    });
  });

  test("--interactive with any other command is refused, naming the flag", () => {
    expect(parseCommandLine(["--interactive"])).toEqual({
      message: "--interactive is only for reset-password",
      ok: false,
    });
    expect(parseCommandLine(["health", "--interactive"])).toEqual({
      message: "--interactive is only for reset-password",
      ok: false,
    });
  });
});

describe("set-address and its address", () => {
  test("set-address takes the public address as its one argument, beside the flags", () => {
    expect(
      accepted([
        "set-address",
        "https://status.example.test",
        "--data-dir",
        "/d",
      ])
    ).toEqual({
      address: "https://status.example.test",
      command: "set-address",
      flags: { RAAQEB_DATA_DIR: "/d" },
      interactive: false,
      ok: true,
    });
    expect(
      accepted(["--data-dir=/d", "set-address", "http://localhost:3000"])
        .address
    ).toBe("http://localhost:3000");
  });

  test("set-address without an address is refused, saying what it needs", () => {
    expect(refused(["set-address"])).toContain("set-address");
  });

  test("an address that is not an origin is refused before anything opens: no path, no trailing slash", () => {
    for (const address of [
      "https://status.example.test/",
      "https://status.example.test/admin",
      "status.example.test",
      "ftp://status.example.test",
    ]) {
      expect(refused(["set-address", address])).toContain("origin");
    }
  });

  test("set-address takes one address", () => {
    expect(
      refused(["set-address", "https://a.example", "https://b.example"])
    ).toContain("https://b.example");
  });

  test("no other command takes an argument", () => {
    expect(refused(["health", "https://status.example.test"])).toContain(
      "health"
    );
  });
});

describe("the command", () => {
  test("no arguments is serve with no flags", () => {
    expect(accepted([])).toEqual({
      command: "serve",
      flags: {},
      interactive: false,
      ok: true,
    });
  });

  test.each(["serve", "health", "reset-password"] as const)(
    "%s is a command",
    (command) => {
      expect(accepted([command]).command).toBe(command);
    }
  );

  test("the command may follow the flags", () => {
    expect(accepted(["--port", "3000", "health"]).command).toBe("health");
  });

  test("an unknown command is refused by name", () => {
    expect(refused(["export"])).toContain("export");
  });

  test("two commands are refused", () => {
    expect(refused(["serve", "health"])).toContain("health");
  });
});

describe("flags mirror the boot setting variables", () => {
  test.each([
    ["--port", "RAAQEB_PORT"],
    ["--host", "RAAQEB_HOST"],
    ["--data-dir", "RAAQEB_DATA_DIR"],
    ["--trusted-proxies", "RAAQEB_TRUSTED_PROXIES"],
    ["--secret-key", "RAAQEB_SECRET_KEY"],
    ["--database-url", "DATABASE_URL"],
    ["--better-auth-secrets", "BETTER_AUTH_SECRETS"],
  ] as const)("%s sets %s", (flag, variable) => {
    expect(accepted([flag, "value"]).flags).toEqual({ [variable]: "value" });
    expect(accepted([`${flag}=value`]).flags).toEqual({ [variable]: "value" });
  });

  test("a value may contain an equals sign", () => {
    expect(
      accepted(["--database-url=postgres://h/db?sslmode=require"]).flags
    ).toEqual({ DATABASE_URL: "postgres://h/db?sslmode=require" });
  });

  test("an empty value is kept as empty", () => {
    expect(accepted(["--trusted-proxies="]).flags).toEqual({
      RAAQEB_TRUSTED_PROXIES: "",
    });
  });

  test("the last of a repeated flag wins", () => {
    expect(accepted(["--port", "1", "--port", "2"]).flags).toEqual({
      RAAQEB_PORT: "2",
    });
  });

  test("an unknown flag is refused by name", () => {
    expect(refused(["--verbose"])).toContain("--verbose");
  });

  test("a flag without a value is refused by name", () => {
    expect(refused(["--port"])).toContain("--port");
    expect(refused(["--port", "--host", "h"])).toContain("--port");
  });

  test("a refusal never repeats a value", () => {
    const message = refused(["--secret-key", "hunter2", "--nope"]);
    expect(message).not.toContain("hunter2");
    const missing = refused(["--secret-key=hunter2", "--port"]);
    expect(missing).not.toContain("hunter2");
  });
});
