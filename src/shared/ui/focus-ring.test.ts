import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const stylesheet = await Bun.file(
  new URL("../../styles.css", import.meta.url)
).text();

type Scheme = "dark" | "light";

const oklchPattern = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/;
const aliasPattern = /^var\((--[\w-]+)\)$/;
const lightDarkPattern = /^light-dark\((.*)\)$/s;
const tokenPattern = /^ {2}(--[\w-]+): ([^;]+);/gm;

/** The tokens of the stylesheet's `:root`, name to raw value. */
const tokens = new Map(
  [...stylesheet.matchAll(tokenPattern)].map((match) => [
    match[1] ?? "",
    (match[2] ?? "").trim(),
  ])
);

/** The two arguments of a `light-dark()` value, split at its top-level comma. */
function lightDarkOf(value: string): [string, string] | undefined {
  const inner = lightDarkPattern.exec(value)?.[1];
  if (inner === undefined) {
    return undefined;
  }
  let depth = 0;
  for (const [index, char] of [...inner].entries()) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      return [inner.slice(0, index).trim(), inner.slice(index + 1).trim()];
    }
  }
  return undefined;
}

/** WCAG relative luminance of an `oklch()` colour. */
function luminanceOf(colour: string): number {
  const parts = oklchPattern.exec(colour);
  if (!parts) {
    throw new Error(`Not a colour the test reads: ${colour}`);
  }
  const lightness = Number(parts[1]) / 100;
  const a = Number(parts[2]) * Math.cos((Number(parts[3]) * Math.PI) / 180);
  const b = Number(parts[2]) * Math.sin((Number(parts[3]) * Math.PI) / 180);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return (
    0.2126 *
      clamp(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s) +
    0.7152 *
      clamp(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s) +
    0.0722 *
      clamp(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s)
  );
}

/** A token's colour in a scheme, following `var()` and `light-dark()`. */
function colourOf(name: string, scheme: Scheme): string {
  const value = tokens.get(name);
  if (value === undefined) {
    throw new Error(`The stylesheet has no ${name}`);
  }
  const alias = aliasPattern.exec(value)?.[1];
  if (alias) {
    return colourOf(alias, scheme);
  }
  const pair = lightDarkOf(value);
  return pair ? pair[scheme === "light" ? 0 : 1] : value;
}

function contrast(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

// What the ring is drawn over: the page, a card or popover, a hovered row and the chosen segment.
const surfaces = ["--background", "--card", "--popover", "--secondary"];

describe("the keyboard focus ring", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const surface of surfaces) {
      test(`reaches 3 to 1 against ${surface} in ${scheme} mode`, () => {
        const ring = luminanceOf(colourOf("--focus", scheme));
        const behind = luminanceOf(colourOf(surface, scheme));
        expect(contrast(ring, behind)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  test("is the one ring every control draws: no component keeps its own faint one", async () => {
    const files = [...new Glob("src/**/*.tsx").scanSync(".")];
    const faint: string[] = [];
    for (const file of files) {
      // biome-ignore lint/performance/noAwaitInLoops: a scan of a few hundred small files
      if ((await Bun.file(file).text()).includes("ring-ring-soft")) {
        faint.push(file);
      }
    }
    expect(faint).toEqual([]);
  });
});
