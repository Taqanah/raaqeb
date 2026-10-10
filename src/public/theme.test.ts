import { describe, expect, test } from "bun:test";
import { themeScript, themeStorageKey } from "./theme.tsx";

/** Runs the inline script against a stored value and answers the theme it set on the document. */
function run(
  fallback: "dark" | "light" | "system",
  stored: string | null | Error
): string | undefined {
  let set: string | undefined;
  const scope = {
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          if (name === "data-theme") {
            set = value;
          }
        },
      },
    },
    localStorage: {
      getItem: (key: string) => {
        if (stored instanceof Error) {
          throw stored;
        }
        return key === themeStorageKey ? stored : null;
      },
    },
  };
  new Function("document", "localStorage", themeScript(fallback))(
    scope.document,
    scope.localStorage
  );
  return set;
}

describe("the theme script before first paint (ADR-0006)", () => {
  test("with nothing stored the page's default is the theme", () => {
    expect(run("dark", null)).toBe("dark");
  });

  test("the visitor's stored choice wins over the page's default", () => {
    expect(run("dark", "light")).toBe("light");
    expect(run("light", "system")).toBe("system");
  });

  test("a stored value that is no theme falls back to the page's default", () => {
    expect(run("light", "purple")).toBe("light");
  });

  test("storage that refuses to be read falls back to the page's default", () => {
    expect(run("system", new Error("denied"))).toBe("system");
  });
});
