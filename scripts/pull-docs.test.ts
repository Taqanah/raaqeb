import { describe, expect, test } from "bun:test";
import {
  fallbackToBranch,
  installedVersions,
  isCurrent,
  type Library,
  libraries,
  pulledRecord,
  refProbe,
  resolveRef,
  type Versions,
} from "./pull-docs.ts";

const lock = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "raaqeb", "devDependencies": { "zod": "4.6.4", }, },
  },
  "packages": {
    "zod": ["zod@4.6.4", "", {}, "sha512-a"],
    "@tanstack/react-router": ["@tanstack/react-router@1.170.35", "", { "dependencies": { "@tanstack/history": "1.162.1", }, }, "sha512-b"],
    "@tanstack/react-start": ["@tanstack/react-start@1.168.52", "", {}, "sha512-c"],
    "better-auth/zod": ["zod@3.25.0", "", {}, "sha512-d"],
  },
}
`;

const lib = (name: string): Library => {
  const found = libraries.find((l) => l.name === name);
  if (!found) {
    throw new Error(`missing table entry: ${name}`);
  }
  return found;
};

const fromLock = (entries: Record<string, string>): Versions =>
  new Map(
    Object.entries(entries).map(([k, version]) => [
      k,
      { source: "bun.lock" as const, version },
    ])
  );

describe("installedVersions", () => {
  test("reads the resolved version of scoped and unscoped packages from bun.lock, trailing commas included", () => {
    const versions = installedVersions(lock);
    expect(versions.get("zod")).toEqual({
      source: "bun.lock",
      version: "4.6.4",
    });
    expect(versions.get("@tanstack/react-start")?.version).toBe("1.168.52");
  });

  test("a copy nested under another package does not shadow the top-level version", () => {
    expect(installedVersions(lock).get("zod")?.version).toBe("4.6.4");
    expect(installedVersions(lock).has("better-auth/zod")).toBe(false);
  });
});

const namesPackageAndLock = /zod.*bun\.lock/;

describe("resolveRef", () => {
  test("a library whose repo tags releases is pinned to the version in bun.lock", () => {
    const ref = resolveRef(lib("zod"), fromLock({ zod: "4.6.4" }), "1.4.2");
    expect(ref).toEqual({ ref: "v4.6.4", source: "bun.lock" });
  });

  test("TanStack Start docs follow the router's version because both live in one repo", () => {
    const versions = fromLock({
      "@tanstack/react-router": "1.170.35",
      "@tanstack/react-start": "1.168.52",
    });
    expect(resolveRef(lib("tanstack-router"), versions, "1.4.2").ref).toBe(
      "v1.170.35"
    );
  });

  test("Bun docs are pinned to the running Bun version", () => {
    expect(resolveRef(lib("bun"), new Map(), "1.4.2")).toEqual({
      ref: "bun-v1.4.2",
      source: "bun runtime",
    });
  });

  test("shadcn's tag carries the package name", () => {
    expect(
      resolveRef(lib("shadcn"), fromLock({ shadcn: "4.21.0" }), "1.4.2").ref
    ).toBe("shadcn@4.21.0");
  });

  test("a docs repo without release tags mirrors its default branch", () => {
    expect(resolveRef(lib("drizzle"), new Map(), "1.4.2")).toEqual({
      ref: "main",
      source: "default branch",
    });
  });

  test("a version read from the registry keeps that source on the ref", () => {
    const versions: Versions = new Map([
      ["zod", { source: "registry", version: "4.6.4" }],
    ]);
    expect(resolveRef(lib("zod"), versions, "1.4.2").source).toBe("registry");
  });

  test("a pinned library with no known version fails and names the package", () => {
    expect(() => resolveRef(lib("zod"), new Map(), "1.4.2")).toThrow(
      namesPackageAndLock
    );
  });
});

describe("the pulled record", () => {
  const ref = { ref: "v4.6.4", source: "bun.lock" as const };
  const date = new Date("2026-09-13T10:00:00Z");
  const nextDay = new Date("2026-09-14T10:00:00Z");

  test("names the ref, its source and the date", () => {
    const record = pulledRecord(lib("zod"), ref, date);
    expect(record).toContain("v4.6.4");
    expect(record).toContain("bun.lock");
    expect(record).toContain("2026-09-13");
  });

  test("a folder whose record names the same tag is current on any later day", () => {
    const record = pulledRecord(lib("zod"), ref, date);
    expect(isCurrent(record, ref, date, lib("zod"))).toBe(true);
    expect(isCurrent(record, ref, nextDay, lib("zod"))).toBe(true);
  });

  test("a folder with no record, or a record at another ref, is not current", () => {
    expect(isCurrent(null, ref, date, lib("zod"))).toBe(false);
    const older = pulledRecord(
      lib("zod"),
      { ref: "v4.6.3", source: "bun.lock" },
      date
    );
    expect(isCurrent(older, ref, date, lib("zod"))).toBe(false);
  });

  test("a branch mirror is current only on the day it was pulled, because the branch moves", () => {
    const branch = { ref: "main", source: "default branch" as const };
    const record = pulledRecord(lib("drizzle"), branch, date);
    expect(isCurrent(record, branch, date, lib("drizzle"))).toBe(true);
    expect(isCurrent(record, branch, nextDay, lib("drizzle"))).toBe(false);
  });

  test("a record lists the docs paths, so a change to the table's paths makes the folder stale", () => {
    const record = pulledRecord(lib("tanstack-router"), ref, date);
    expect(record).toContain("docs/router");
    const moved = { ...lib("tanstack-router"), paths: ["docs/router"] };
    expect(isCurrent(record, ref, date, lib("tanstack-router"))).toBe(true);
    expect(isCurrent(record, ref, date, moved)).toBe(false);
  });

  test("when the repo lacks the tag for the installed version, the default branch stands in and the record says which tag is missing", () => {
    const fallback = fallbackToBranch(lib("tanstack-router"), {
      ref: "v1.170.35",
      source: "bun.lock",
    });
    expect(fallback).toEqual({
      missingTag: "v1.170.35",
      ref: "main",
      source: "default branch",
    });
    expect(pulledRecord(lib("tanstack-router"), fallback, date)).toContain(
      "no tag v1.170.35"
    );
  });
});

describe("the tag probe", () => {
  test("git ls-remote exit 0 means the ref exists and exit 2 means it does not", () => {
    expect(refProbe(0, "")).toBe(true);
    expect(refProbe(2, "")).toBe(false);
  });

  test("any other exit is a transport failure and never counts as a missing tag", () => {
    expect(() => refProbe(128, "fatal: unable to access")).toThrow(
      "unable to access"
    );
  });
});

describe("the library table", () => {
  test("has every library from the research report", () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    const names = libraries.map((l) => l.name).sort(byName);
    expect(names).toEqual(
      [
        "base-ui",
        "better-auth",
        "biome",
        "bun",
        "drizzle",
        "fumadocs",
        "lingui",
        "nodemailer",
        "playwright",
        "react",
        "shadcn",
        "tailwind",
        "tanstack-form",
        "tanstack-query",
        "tanstack-router",
        "ultracite",
        "vite",
        "zod",
      ].sort(byName)
    );
  });

  test("every library has a docs path and names its default branch; pinned ones add a tag rule", () => {
    for (const l of libraries) {
      expect(l.paths.length).toBeGreaterThan(0);
      expect(l.branch.length).toBeGreaterThan(0);
      expect(Boolean(l.tag)).toBe(Boolean(l.package) || l.name === "bun");
    }
  });
});
