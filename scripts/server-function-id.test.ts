import { describe, expect, test } from "bun:test";
import { serverFunctionIds } from "./server-function-id.ts";

const handler = (name: string) => `${name}_createServerFn_handler`;

describe("a server function's id", () => {
  test("names the module under src and the function, so its URL reads as what it calls", () => {
    const id = serverFunctionIds();
    expect(
      id({
        filename: "src/routes/admin/settings/index.tsx",
        functionName: handler("save"),
      })
    ).toBe("routes.admin.settings.index--save");
    expect(
      id({
        filename: "src/routes/-monitors.ts",
        functionName: handler("testMonitorFn"),
      })
    ).toBe("routes.-monitors--testMonitorFn");
  });

  test("is the same on every build and in each of the build's environments", () => {
    const source = {
      filename: "src/routes/-pages.ts",
      functionName: handler("savePageFn"),
    };
    const first = serverFunctionIds();
    expect(first(source)).toBe("routes.-pages--savePageFn");
    // The client and the server environment each ask for the same function.
    expect(first(source)).toBe("routes.-pages--savePageFn");
    expect(serverFunctionIds()(source)).toBe("routes.-pages--savePageFn");
  });

  test("keeps the number Start gives a second function of the same name in one file", () => {
    expect(
      serverFunctionIds()({
        filename: "src/routes/-pages.ts",
        functionName: `${handler("read")}_1`,
      })
    ).toBe("routes.-pages--read_1");
  });

  test("holds only characters a URL path segment carries as they are", () => {
    expect(
      serverFunctionIds()({
        filename: "src/routes/api/openapi[.]json.ts",
        functionName: handler("read"),
      })
    ).toBe("routes.api.openapi_._json--read");
    expect(
      serverFunctionIds()({
        filename: "src\\routes\\-admin.ts",
        functionName: handler("readShell"),
      })
    ).toBe("routes.-admin--readShell");
  });

  test("two functions that would share an id fail the build rather than one answering for the other", () => {
    const id = serverFunctionIds();
    id({ filename: "src/routes/a/b.ts", functionName: handler("read") });
    expect(() =>
      id({ filename: "src/routes/a.b.ts", functionName: handler("read") })
    ).toThrow("routes.a.b--read");
  });

  test("a file outside the project, which would put a directory of the machine in the URL, fails the build", () => {
    const id = serverFunctionIds();
    expect(() =>
      id({
        filename: "../../home/someone/shared.ts",
        functionName: handler("read"),
      })
    ).toThrow("outside the project");
    expect(() =>
      id({ filename: "/home/someone/shared.ts", functionName: handler("read") })
    ).toThrow("outside the project");
    // On Windows a file on another drive stays absolute.
    expect(() =>
      id({
        filename: "D:\\Users\\someone\\shared.ts",
        functionName: handler("read"),
      })
    ).toThrow("outside the project");
  });

  test("a file in the project but outside src, whose id would not name a module, fails the build too", () => {
    const id = serverFunctionIds();
    for (const filename of [
      "website/routes/a.ts",
      "node_modules/some-lib/dist/a.js",
      "src-copy/a.ts",
    ]) {
      expect(() => id({ filename, functionName: handler("read") })).toThrow(
        "outside src"
      );
    }
  });
});
