import { describe, expect, test } from "bun:test";
import { copies, installs } from "./copy.ts";
import { bench } from "./landing/bench.ts";

/** An install page's text with each shell line continuation joined into one line. */
async function installPage(name: string): Promise<string> {
  const text = await Bun.file(
    `${import.meta.dir}/content/docs/operate/${name}`
  ).text();
  return text.replaceAll(/\s*\\\n\s*/g, " ");
}

describe("the install commands the landing page offers", () => {
  for (const [way, { code }] of Object.entries(installs)) {
    test(`the ${way} command is the one the Arabic and English install pages give`, async () => {
      expect(await installPage("install.mdx")).toContain(code);
      expect(await installPage("install.en.mdx")).toContain(code);
    });
  }
});

describe("the figures under the memory chart", () => {
  for (const [locale, copy] of Object.entries(copies)) {
    test(`the ${locale} binary size is the one the benchmark measured`, () => {
      expect(copy.server.figures.map(([figure]) => figure)).toContain(
        String(bench.binaryMb)
      );
    });
  }
});
