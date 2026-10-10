import { describe, expect, test } from "bun:test";
import { type Capability, capabilities, createRegistry } from "./registry.ts";

function fakeLoader<Name extends string>(name: Name) {
  let imports = 0;
  const loader = () => {
    imports += 1;
    return Promise.resolve<Capability<Name>>({ name });
  };
  return { imports: () => imports, loader };
}

describe("capability registry", () => {
  test("lists every capability compiled in, enabled or not", () => {
    const registry = createRegistry({
      browser: fakeLoader("browser").loader,
      ping: fakeLoader("ping").loader,
    });
    expect([...registry.names].toSorted()).toEqual(["browser", "ping"]);
  });

  test("a capability nobody loads is never imported", () => {
    const browser = fakeLoader("browser");
    createRegistry({ browser: browser.loader });
    expect(browser.imports()).toBe(0);
  });

  test("loading a capability imports its module once and answers the same instance after", async () => {
    const browser = fakeLoader("browser");
    const registry = createRegistry({ browser: browser.loader });
    const first = await registry.load("browser");
    const second = await registry.load("browser");
    expect(first).toBe(second);
    expect(first.name).toBe("browser");
    expect(browser.imports()).toBe(1);
  });

  test("a failed import is forgotten so the next load tries again", async () => {
    let attempts = 0;
    const registry = createRegistry({
      browser: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("module missing"))
          : Promise.resolve<Capability<"browser">>({ name: "browser" });
      },
    });
    await expect(registry.load("browser")).rejects.toThrow("module missing");
    expect((await registry.load("browser")).name).toBe("browser");
    expect(attempts).toBe(2);
  });

  test("only a compiled-in name is a capability", () => {
    const registry = createRegistry({ browser: fakeLoader("browser").loader });
    expect(registry.has("browser")).toBe(true);
    expect(registry.has("ping")).toBe(false);
  });

  test("v1 ships no optional capability", () => {
    expect(capabilities.names).toEqual([]);
    expect(capabilities.has("browser")).toBe(false);
  });
});
