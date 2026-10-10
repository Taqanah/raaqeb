import { describe, expect, test } from "bun:test";
import { isVersion, newerVersion } from "./version.ts";

describe("a release version", () => {
  test("is three numbers, with an alpha, beta or rc pre-release after a hyphen when it has one", () => {
    for (const text of [
      "0.1.0",
      "12.0.3",
      "0.1.0-alpha.1",
      "0.1.0-beta.12",
      "1.0.0-rc.1",
    ]) {
      expect(isVersion(text)).toBe(true);
    }
  });

  test("is refused when it is padded, prefixed, short, long, has build metadata or an empty pre-release", () => {
    for (const text of [
      "",
      " 0.1.0",
      "v0.1.0",
      "0.1",
      "1",
      "1.0.0.0",
      "01.0.0",
      "1.0.0-",
      "1.0.0-rc..1",
      "1.0.0-rc.01",
      "1.0.0+build",
      "latest",
    ]) {
      expect(isVersion(text)).toBe(false);
    }
  });
});

describe("a published version offered to a running build", () => {
  test("is offered when it is newer, by number and not by text", () => {
    expect(newerVersion("1.2.0", "1.1.9")).toBe(true);
    expect(newerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(newerVersion("1.2.0", "1.2.0")).toBe(false);
    expect(newerVersion("1.2.0", "1.10.0")).toBe(false);
  });

  test("a stable release is newer than its own release candidate, and a candidate than its beta and alpha", () => {
    expect(newerVersion("0.1.0", "0.1.0-rc.1")).toBe(true);
    expect(newerVersion("0.1.0", "0.1.0-alpha.3")).toBe(true);
    expect(newerVersion("0.1.0-rc.1", "0.1.0-beta.3")).toBe(true);
    expect(newerVersion("0.1.0-beta.1", "0.1.0-alpha.9")).toBe(true);
    expect(newerVersion("0.1.0-rc.1", "0.1.0")).toBe(false);
  });

  test("pre-release numbers compare as numbers, so alpha.10 follows alpha.2", () => {
    expect(newerVersion("0.1.0-alpha.10", "0.1.0-alpha.2")).toBe(true);
    expect(newerVersion("0.1.0-alpha.2", "0.1.0-alpha.10")).toBe(false);
  });

  test("a pre-release is never offered to a stable build, even a newer one", () => {
    expect(newerVersion("0.2.0-rc.1", "0.1.0")).toBe(false);
    expect(newerVersion("0.1.1-alpha.1", "0.1.0")).toBe(false);
    expect(newerVersion("0.2.0-beta.1", "0.0.0")).toBe(false);
  });

  test("a pre-release is offered to a build on a pre-release when it is newer", () => {
    expect(newerVersion("0.1.0-alpha.2", "0.1.0-alpha.1")).toBe(true);
    expect(newerVersion("0.2.0-alpha.1", "0.1.0-rc.1")).toBe(true);
    expect(newerVersion("0.2.0-rc.1", "0.2.0-rc.1")).toBe(false);
  });

  test("a missing minor or patch reads as zero, and text that is not a version is never newer", () => {
    expect(newerVersion("1.2", "1.2.0")).toBe(false);
    expect(newerVersion("1.3", "1.2.9")).toBe(true);
    expect(newerVersion("1.2.0", "1.2")).toBe(false);
    expect(newerVersion("1.2.0", "0.9")).toBe(true);
    expect(newerVersion("beta", "0.0.0")).toBe(false);
    expect(newerVersion("1.0.0", "main")).toBe(false);
    expect(newerVersion("1.0.0+build", "0.9.0")).toBe(false);
  });
});
