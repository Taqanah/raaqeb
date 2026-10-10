import { afterAll, describe, expect, test } from "bun:test";
import { readConfigFile, writeConfigFile } from "./datadir.ts";
import {
  decrypt,
  encrypt,
  generateInstallKey,
  importInstallKey,
} from "./installkey.ts";
import {
  type BootSettings,
  type BootValues,
  type BootVariable,
  bootVariables,
  resolveAddress,
  resolveBootSettings,
} from "./settings.ts";

const base64urlKey = /^[A-Za-z0-9_-]{43}$/;

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
});

async function scratch(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tempDirs.push(dir);
  return dir;
}

async function modeOf(path: string): Promise<string> {
  const { mode } = await Bun.file(path).stat();
  return mode.toString(8).slice(-3);
}

async function resolved(
  flags: BootValues,
  env: BootValues
): Promise<BootSettings> {
  const result = await resolveBootSettings(flags, env);
  if (!result.ok) {
    throw new Error(`expected boot settings: ${result.message}`);
  }
  return result.settings;
}

/** The notes of a boot that must be accepted, so a refusal never reads as a note left out. */
async function notesOf(flags: BootValues, env: BootValues): Promise<string[]> {
  const result = await resolveBootSettings(flags, env);
  if (!result.ok) {
    throw new Error(`expected boot settings: ${result.message}`);
  }
  return result.notes;
}

async function refused(flags: BootValues, env: BootValues): Promise<string> {
  const result = await resolveBootSettings(flags, env);
  if (result.ok) {
    throw new Error("expected a refused boot");
  }
  return result.message;
}

/** The key an install would reuse: whatever decrypts what this boot encrypted. */
async function sameKey(
  a: BootSettings["installKey"],
  b: BootSettings["installKey"]
): Promise<boolean> {
  return (await decrypt(b, await encrypt(a, "probe"))) === "probe";
}

describe("resolution order", () => {
  test("with no source a setting takes its default", async () => {
    const dataDir = await scratch();
    const settings = await resolved({}, { RAAQEB_DATA_DIR: dataDir });
    expect(settings.port).toBe(3000);
    expect(settings.host).toBe("127.0.0.1");
    expect(settings.trustedProxies).toEqual([]);
    expect(settings.databaseUrl).toBeUndefined();
    expect(settings.betterAuthSecrets).toBeUndefined();
  });

  test("the default data directory is ./data under the working directory", async () => {
    const cwd = process.cwd();
    const dir = await scratch();
    process.chdir(dir);
    try {
      const settings = await resolved({}, {});
      expect(settings.dataDir).toBe("./data");
      expect(await modeOf(`${dir}/data`)).toBe("700");
    } finally {
      process.chdir(cwd);
    }
  });

  test("a variable beats the default", async () => {
    const dataDir = await scratch();
    const settings = await resolved(
      {},
      {
        BETTER_AUTH_SECRETS: "1:s",
        DATABASE_URL: "postgres://h/db",
        RAAQEB_DATA_DIR: dataDir,
        RAAQEB_HOST: "0.0.0.0",
        RAAQEB_PORT: "8080",
        RAAQEB_TRUSTED_PROXIES: "10.0.0.1",
      }
    );
    expect(settings).toMatchObject({
      betterAuthSecrets: "1:s",
      dataDir,
      databaseUrl: "postgres://h/db",
      host: "0.0.0.0",
      port: 8080,
      trustedProxies: ["10.0.0.1"],
    });
  });

  test("a flag beats a variable", async () => {
    const flagDir = await scratch();
    const envDir = await scratch();
    const settings = await resolved(
      {
        BETTER_AUTH_SECRETS: "1:flag",
        DATABASE_URL: "postgres://flag/db",
        RAAQEB_DATA_DIR: flagDir,
        RAAQEB_HOST: "::1",
        RAAQEB_PORT: "9000",
        RAAQEB_TRUSTED_PROXIES: "10.0.0.2",
      },
      {
        BETTER_AUTH_SECRETS: "1:env",
        DATABASE_URL: "postgres://env/db",
        RAAQEB_DATA_DIR: envDir,
        RAAQEB_HOST: "0.0.0.0",
        RAAQEB_PORT: "8080",
        RAAQEB_TRUSTED_PROXIES: "10.0.0.1",
      }
    );
    expect(settings).toMatchObject({
      betterAuthSecrets: "1:flag",
      dataDir: flagDir,
      databaseUrl: "postgres://flag/db",
      host: "::1",
      port: 9000,
      trustedProxies: ["10.0.0.2"],
    });
  });

  test("says whether the trusted proxies came from the flag or the variable, and nothing when neither gives any", async () => {
    const dataDir = await scratch();
    const env = {
      RAAQEB_DATA_DIR: dataDir,
      RAAQEB_TRUSTED_PROXIES: "10.0.0.1",
    };
    expect((await resolved({}, env)).trustedProxiesFrom).toBe("variable");
    expect(
      (await resolved({ RAAQEB_TRUSTED_PROXIES: "10.0.0.2" }, env))
        .trustedProxiesFrom
    ).toBe("flag");
    expect(
      (await resolved({}, { RAAQEB_DATA_DIR: dataDir })).trustedProxiesFrom
    ).toBeUndefined();
  });

  test("an empty flag counts as unset and does not fall back to the variable", async () => {
    const dataDir = await scratch();
    const settings = await resolved(
      { RAAQEB_PORT: "" },
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_PORT: "8080" }
    );
    expect(settings.port).toBe(3000);
  });

  test("an empty variable counts as unset", async () => {
    const dataDir = await scratch();
    const settings = await resolved(
      {},
      { DATABASE_URL: "", RAAQEB_DATA_DIR: dataDir, RAAQEB_PORT: "" }
    );
    expect(settings.port).toBe(3000);
    expect(settings.databaseUrl).toBeUndefined();
  });
});

describe("the install key", () => {
  test("is generated into config.json when no source has one", async () => {
    const dataDir = await scratch();
    const settings = await resolved({}, { RAAQEB_DATA_DIR: dataDir });
    const file = await readConfigFile(dataDir);
    expect(file.ok && file.config.installKey).toMatch(base64urlKey);
    expect(await modeOf(`${dataDir}/config.json`)).toBe("600");
    const stored = await importInstallKey(
      (file.ok && file.config.installKey) || ""
    );
    expect(stored && (await sameKey(settings.installKey, stored))).toBe(true);
  });

  test("the next boot reuses the generated key", async () => {
    const dataDir = await scratch();
    const first = await resolved({}, { RAAQEB_DATA_DIR: dataDir });
    const second = await resolved({}, { RAAQEB_DATA_DIR: dataDir });
    expect(await sameKey(first.installKey, second.installKey)).toBe(true);
  });

  test("the variable beats config.json and leaves the file untouched", async () => {
    const dataDir = await scratch();
    const fromFile = generateInstallKey();
    const fromEnv = generateInstallKey();
    await writeConfigFile(dataDir, { installKey: fromFile });
    const settings = await resolved(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_SECRET_KEY: fromEnv }
    );
    const env = await importInstallKey(fromEnv);
    expect(env && (await sameKey(settings.installKey, env))).toBe(true);
    expect(await readConfigFile(dataDir)).toEqual({
      config: { installKey: fromFile },
      ok: true,
    });
  });

  test("the variable is never written to config.json", async () => {
    const dataDir = await scratch();
    await resolved(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_SECRET_KEY: generateInstallKey() }
    );
    expect(await readConfigFile(dataDir)).toEqual({ config: {}, ok: true });
  });

  test("a key that is not 32 bytes in base64url refuses the boot by name and length", async () => {
    const dataDir = await scratch();
    const message = await refused(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_SECRET_KEY: "tooshort" }
    );
    expect(message).toContain("RAAQEB_SECRET_KEY");
    expect(message).toContain("8");
    expect(message).not.toContain("tooshort");
  });

  test("a config.json key that is not a key refuses the boot by file name", async () => {
    const dataDir = await scratch();
    await writeConfigFile(dataDir, { installKey: "tooshort" });
    const message = await refused({}, { RAAQEB_DATA_DIR: dataDir });
    expect(message).toContain("config.json");
    expect(message).not.toContain("tooshort");
  });
});

describe("the database URL", () => {
  test("config.json holds it encrypted with the install key", async () => {
    const dataDir = await scratch();
    const encoded = generateInstallKey();
    const key = await importInstallKey(encoded);
    if (!key) {
      throw new Error("a generated install key must import");
    }
    await writeConfigFile(dataDir, {
      databaseUrl: await encrypt(key, "postgres://file/db"),
      installKey: encoded,
    });
    const settings = await resolved({}, { RAAQEB_DATA_DIR: dataDir });
    expect(settings.databaseUrl).toBe("postgres://file/db");
    // Chosen on the onboarding page, so the settings screen may still show it as the install's own choice.
    expect(settings.databaseUrlFromEnvironment).toBe(false);
  });

  test("the variable beats config.json", async () => {
    const dataDir = await scratch();
    const encoded = generateInstallKey();
    const key = await importInstallKey(encoded);
    if (!key) {
      throw new Error("a generated install key must import");
    }
    await writeConfigFile(dataDir, {
      databaseUrl: await encrypt(key, "postgres://file/db"),
      installKey: encoded,
    });
    const settings = await resolved(
      {},
      { DATABASE_URL: "postgres://env/db", RAAQEB_DATA_DIR: dataDir }
    );
    expect(settings.databaseUrl).toBe("postgres://env/db");
    // The database row in settings renders as managed by environment.
    expect(settings.databaseUrlFromEnvironment).toBe(true);
  });

  test("a config.json URL the key cannot open refuses the boot by file name", async () => {
    const dataDir = await scratch();
    const other = await importInstallKey(generateInstallKey());
    if (!other) {
      throw new Error("a generated install key must import");
    }
    await writeConfigFile(dataDir, {
      databaseUrl: await encrypt(other, "postgres://file/db"),
      installKey: generateInstallKey(),
    });
    const message = await refused({}, { RAAQEB_DATA_DIR: dataDir });
    expect(message).toContain("config.json");
    expect(message).toContain("DATABASE_URL");
  });
});

describe("the port and the bind address", () => {
  test.each(["0", "3000", "65535"])("%s is a port", async (port) => {
    const dataDir = await scratch();
    const settings = await resolved(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_PORT: port }
    );
    expect(settings.port).toBe(Number(port));
  });

  test.each(["abc", "-1", "65536", "3000.5", "0x10", " 3000", "3e3"])(
    "%s is not a port and refuses the boot by name and length",
    async (port) => {
      const dataDir = await scratch();
      const message = await refused(
        {},
        { RAAQEB_DATA_DIR: dataDir, RAAQEB_PORT: port }
      );
      expect(message).toContain("RAAQEB_PORT");
      expect(message).toContain(String(port.length));
      expect(message).not.toContain(port);
    }
  );

  test("a blank bind address refuses the boot by name", async () => {
    const dataDir = await scratch();
    const message = await refused(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_HOST: "   " }
    );
    expect(message).toContain("RAAQEB_HOST");
  });
});

describe("the address alone, for raaqeb health", () => {
  test("takes the defaults with no source", () => {
    expect(resolveAddress({}, {})).toEqual({
      host: "127.0.0.1",
      ok: true,
      port: 3000,
    });
  });

  test("a flag beats a variable, and a variable the default", () => {
    expect(
      resolveAddress(
        { RAAQEB_PORT: "4000" },
        { RAAQEB_HOST: "0.0.0.0", RAAQEB_PORT: "5000" }
      )
    ).toEqual({ host: "0.0.0.0", ok: true, port: 4000 });
  });

  test("refuses a bad port by name and length, and a blank bind address by name", () => {
    const port = resolveAddress({}, { RAAQEB_PORT: "abc" });
    expect(port.ok).toBe(false);
    expect(!port.ok && port.message).toContain("RAAQEB_PORT");
    expect(!port.ok && port.message).toContain("3");
    expect(!port.ok && port.message).not.toContain("abc");
    const host = resolveAddress({}, { RAAQEB_HOST: " " });
    expect(!host.ok && host.message).toContain("RAAQEB_HOST");
  });

  test("touches no data directory and mints no install key", async () => {
    const dir = `${await scratch()}/never`;
    resolveAddress({}, { RAAQEB_DATA_DIR: dir });
    expect(await Bun.file(`${dir}/config.json`).exists()).toBe(false);
  });
});

describe("the trusted proxies", () => {
  test("are a comma-separated list, trimmed, with empty entries dropped", async () => {
    const dataDir = await scratch();
    const settings = await resolved(
      {},
      {
        RAAQEB_DATA_DIR: dataDir,
        RAAQEB_TRUSTED_PROXIES: " 10.0.0.1, 10.0.0.0/8 ,,fd00::1 , ",
      }
    );
    expect(settings.trustedProxies).toEqual([
      "10.0.0.1",
      "10.0.0.0/8",
      "fd00::1",
    ]);
  });

  test("an entry that is not an address or a range refuses the boot naming the variable, never the entry", async () => {
    const dataDir = await scratch();
    const message = await refused(
      {},
      {
        RAAQEB_DATA_DIR: dataDir,
        RAAQEB_TRUSTED_PROXIES: "10.0.0.1, proxy.internal",
      }
    );
    expect(message).toContain("RAAQEB_TRUSTED_PROXIES");
    expect(message).not.toContain("proxy.internal");
  });
});

describe("Better Auth's secret override", () => {
  test("must be in the versioned form, or the boot is refused naming the variable, never the value", async () => {
    const dataDir = await scratch();
    const message = await refused(
      {},
      {
        BETTER_AUTH_SECRETS: "unversioned-secret-value",
        RAAQEB_DATA_DIR: dataDir,
      }
    );
    expect(message).toContain("BETTER_AUTH_SECRETS");
    expect(message).toContain("24 characters");
    expect(message).not.toContain("unversioned");
    const duplicate = await refused(
      {},
      { BETTER_AUTH_SECRETS: "1:a-secret,1:another", RAAQEB_DATA_DIR: dataDir }
    );
    expect(duplicate).toContain("BETTER_AUTH_SECRETS");
    expect(duplicate).not.toContain("a-secret");
    const settings = await resolved(
      {},
      {
        BETTER_AUTH_SECRETS: "2:new-secret,1:old-secret",
        RAAQEB_DATA_DIR: dataDir,
      }
    );
    expect(settings.betterAuthSecrets).toBe("2:new-secret,1:old-secret");
  });
});

describe("the data directory", () => {
  test("is created with mode 0700 at the resolved path", async () => {
    const dataDir = `${await scratch()}/nested/raaqeb`;
    await resolved({}, { RAAQEB_DATA_DIR: dataDir });
    expect(await modeOf(dataDir)).toBe("700");
  });

  test("an existing directory wider than 0700 is noted, not changed", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    const notes = await notesOf({}, { RAAQEB_DATA_DIR: dataDir });
    expect(notes.join("\n")).toContain("wider than 0700");
    expect(await modeOf(dataDir)).toBe("755");
  });

  test("a wide directory with no config.json draws no note, since the key and the URL come from the environment", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    const notes = await notesOf(
      {},
      {
        DATABASE_URL: "postgres://raaqeb@127.0.0.1/raaqeb",
        RAAQEB_DATA_DIR: dataDir,
        RAAQEB_SECRET_KEY: generateInstallKey(),
      }
    );
    expect(notes.join("\n")).not.toContain("wider");
    expect(await Bun.file(`${dataDir}/config.json`).exists()).toBe(false);
  });

  test("a wide directory holding config.json draws the note even when the environment gives the key", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    await writeConfigFile(dataDir, { installKey: generateInstallKey() });
    const notes = await notesOf(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_SECRET_KEY: generateInstallKey() }
    );
    expect(notes).toContain(
      "the data directory's mode is wider than 0700; config.json holds secrets"
    );
  });

  test("a wide directory holding the SQLite database and no config.json draws a note naming the database", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    await Bun.write(`${dataDir}/raaqeb.sqlite`, "");
    const notes = await notesOf(
      {},
      { RAAQEB_DATA_DIR: dataDir, RAAQEB_SECRET_KEY: generateInstallKey() }
    );
    expect(notes).toContain(
      "the data directory's mode is wider than 0700; raaqeb.sqlite holds secrets"
    );
  });

  test("a wide directory holding both config.json and the SQLite database names both in one note", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    await Bun.write(`${dataDir}/raaqeb.sqlite`, "");
    const notes = await notesOf({}, { RAAQEB_DATA_DIR: dataDir });
    expect(notes.filter((note) => note.includes("wider"))).toEqual([
      "the data directory's mode is wider than 0700; config.json and raaqeb.sqlite hold secrets",
    ]);
  });

  test("a directory of mode 0700 draws no note", async () => {
    const dataDir = await scratch();
    const notes = await notesOf({}, { RAAQEB_DATA_DIR: dataDir });
    expect(notes.join("\n")).not.toContain("wider");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a directory that cannot take config.json refuses the boot by file name",
    async () => {
      const dataDir = await scratch();
      await Bun.$`chmod 500 ${dataDir}`.quiet();
      try {
        const message = await refused({}, { RAAQEB_DATA_DIR: dataDir });
        expect(message).toContain("config.json");
        expect(message).not.toContain(dataDir);
      } finally {
        await Bun.$`chmod 700 ${dataDir}`.quiet();
      }
    }
  );

  test("a config.json that is not a config refuses the boot by file name", async () => {
    const dataDir = await scratch();
    await Bun.write(`${dataDir}/config.json`, "{");
    const message = await refused({}, { RAAQEB_DATA_DIR: dataDir });
    expect(message).toContain("config.json");
  });

  test("a path that cannot be created refuses the boot by name and length", async () => {
    const dataDir = `${await scratch()}/file/inside`;
    await Bun.write(`${dataDir.slice(0, -"/inside".length)}`, "not a dir");
    const message = await refused({}, { RAAQEB_DATA_DIR: dataDir });
    expect(message).toContain("RAAQEB_DATA_DIR");
    expect(message).toContain(String(dataDir.length));
    expect(message).not.toContain(dataDir);
  });
});

describe("the rule against printing a value", () => {
  /** Whether a value can refuse the boot by itself: a host is refused only when blank, and a database URL is passed through. */
  const refusable: Record<BootVariable, boolean> = {
    BETTER_AUTH_SECRETS: true,
    DATABASE_URL: false,
    RAAQEB_DATA_DIR: true,
    RAAQEB_HOST: false,
    RAAQEB_PORT: true,
    RAAQEB_SECRET_KEY: true,
    RAAQEB_TRUSTED_PROXIES: true,
  };

  test.each([...bootVariables])(
    "a refusal caused by %s names the variable and does not repeat its value",
    async (variable) => {
      const dataDir = await scratch();
      const marker = "MARKER_VALUE_NEVER_PRINTED";
      // A data directory under a file cannot be created.
      await Bun.write(`${dataDir}/file`, "");
      const env: BootValues = {
        RAAQEB_DATA_DIR: dataDir,
        [variable]:
          variable === "RAAQEB_DATA_DIR" ? `${dataDir}/file/${marker}` : marker,
      };
      // A marker in a variable no value refuses is accepted; make the port refuse.
      if (!refusable[variable]) {
        env.RAAQEB_PORT = "not a port";
      }
      const message = await refused({}, env);
      expect(message).toContain(refusable[variable] ? variable : "RAAQEB_PORT");
      expect(message).not.toContain(marker);
    }
  );
});
