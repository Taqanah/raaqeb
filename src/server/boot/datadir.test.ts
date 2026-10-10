import { afterAll, describe, expect, test } from "bun:test";
import {
  ensureDataDir,
  inspectDataDir,
  readConfigFile,
  writeConfigFile,
} from "./datadir.ts";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => Bun.$`rm -rf ${dir}`.quiet()));
});

/** A fresh temp directory; the data directory under test is a child of it. */
async function scratch(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tempDirs.push(dir);
  return dir;
}

async function modeOf(path: string): Promise<string> {
  const { mode } = await Bun.file(path).stat();
  return mode.toString(8).slice(-3);
}

async function entries(dir: string): Promise<string[]> {
  return (
    await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, dot: true }))
  ).toSorted();
}

describe("the data directory", () => {
  test("is created with mode 0700, parents included", async () => {
    const dataDir = `${await scratch()}/var/raaqeb`;
    await ensureDataDir(dataDir);
    expect(await modeOf(dataDir)).toBe("700");
  });

  test("an existing directory keeps its mode", async () => {
    const dataDir = `${await scratch()}/data`;
    // Bun's shell builtin mkdir has no -m; chmod is the system binary.
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    await ensureDataDir(dataDir);
    expect(await modeOf(dataDir)).toBe("755");
  });
});

describe("a data directory open to group and others", () => {
  test("is wider than the owner on Linux and macOS, never on Windows, whose modes are made up from the read-only flag", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 755 ${dataDir}`.quiet();
    expect(await ensureDataDir(dataDir, "linux")).toEqual({
      widerThanOwner: true,
    });
    expect(await ensureDataDir(dataDir, "darwin")).toEqual({
      widerThanOwner: true,
    });
    expect(await ensureDataDir(dataDir, "win32")).toEqual({
      widerThanOwner: false,
    });
  });
});

describe("the data directory as it stands", () => {
  test("answers the permission bits alone, without the setgid bit", async () => {
    const dataDir = `${await scratch()}/data`;
    await Bun.$`mkdir ${dataDir} && chmod 2750 ${dataDir}`.quiet();
    expect(await inspectDataDir(dataDir)).toEqual({
      mode: 0o750,
      path: dataDir,
      secrets: [],
    });
  });
});

describe("config.json", () => {
  test("a missing file is an empty config", async () => {
    const dataDir = await scratch();
    expect(await readConfigFile(dataDir)).toEqual({ config: {}, ok: true });
  });

  test("a written config reads back", async () => {
    const dataDir = await scratch();
    await writeConfigFile(dataDir, { databaseUrl: "1.abc", installKey: "k" });
    expect(await readConfigFile(dataDir)).toEqual({
      config: { databaseUrl: "1.abc", installKey: "k" },
      ok: true,
    });
  });

  test("is written with mode 0600 and nothing else is left in the directory", async () => {
    const dataDir = await scratch();
    await writeConfigFile(dataDir, { installKey: "k" });
    expect(await modeOf(`${dataDir}/config.json`)).toBe("600");
    expect(await entries(dataDir)).toEqual(["config.json"]);
  });

  test("rewriting a file with a wider mode narrows it to 0600", async () => {
    const dataDir = await scratch();
    await Bun.write(`${dataDir}/config.json`, "{}");
    await Bun.$`chmod 644 ${dataDir}/config.json`.quiet();
    await writeConfigFile(dataDir, { installKey: "k" });
    expect(await modeOf(`${dataDir}/config.json`)).toBe("600");
  });

  test("a draft left by an interrupted write is replaced, mode included", async () => {
    const dataDir = await scratch();
    await Bun.write(`${dataDir}/config.json.tmp`, "{ half");
    await Bun.$`chmod 644 ${dataDir}/config.json.tmp`.quiet();
    await writeConfigFile(dataDir, { installKey: "k" });
    expect(await modeOf(`${dataDir}/config.json`)).toBe("600");
    expect(await entries(dataDir)).toEqual(["config.json"]);
    expect(await readConfigFile(dataDir)).toEqual({
      config: { installKey: "k" },
      ok: true,
    });
  });

  test("a rewrite replaces the whole file", async () => {
    const dataDir = await scratch();
    await writeConfigFile(dataDir, { databaseUrl: "1.abc", installKey: "k" });
    await writeConfigFile(dataDir, { installKey: "k2" });
    expect(await readConfigFile(dataDir)).toEqual({
      config: { installKey: "k2" },
      ok: true,
    });
  });

  test("only the two known keys are read", async () => {
    const dataDir = await scratch();
    await Bun.write(
      `${dataDir}/config.json`,
      JSON.stringify({ installKey: "k", port: 4000 })
    );
    expect(await readConfigFile(dataDir)).toEqual({
      config: { installKey: "k" },
      ok: true,
    });
  });

  test.each([
    ["malformed JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"k"'],
    ["a key of the wrong type", JSON.stringify({ installKey: 42 })],
    ["a database URL of the wrong type", JSON.stringify({ databaseUrl: null })],
  ])(
    "a file that is not a config is refused by file name: %s",
    async (_, content) => {
      const dataDir = await scratch();
      await Bun.write(`${dataDir}/config.json`, content);
      const result = await readConfigFile(dataDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("config.json");
      }
    }
  );
});
