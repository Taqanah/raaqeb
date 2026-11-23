/**
 * Writes src/server/checks/public-suffixes.ts from the Public Suffix List:
 * its ICANN section's rules, the zones registries run, in punycode, since a
 * monitor's host arrives that way. The private section is left out: its
 * names (`github.io`) are registrations a registry holds.
 * Run: bun scripts/public-suffixes.ts
 */
const source = "https://publicsuffix.org/list/public_suffix_list.dat";
const ruleShape = /^(!|\*\.)?(.+)$/;
const out = `${import.meta.dir}/../src/server/checks/public-suffixes.ts`;

const response = await fetch(source);
if (!response.ok) {
  throw new Error(`${source} answered ${response.status}`);
}
const list = await response.text();
const icann = list.match(
  /\/\/ ===BEGIN ICANN DOMAINS===\n([\s\S]*?)\/\/ ===END ICANN DOMAINS===/
)?.[1];
const version = list.match(/^\/\/ VERSION: (.+)$/m)?.[1];
if (icann === undefined || version === undefined) {
  throw new Error("the list has no ICANN section or no VERSION line");
}

/** A rule in punycode, its `!` or `*.` kept. */
function ascii(rule: string): string {
  const [, prefix = "", name = ""] = ruleShape.exec(rule) ?? [];
  return prefix + new URL(`http://${name}`).hostname;
}

const rules = icann
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("//"))
  .map(ascii);

await Bun.write(
  out,
  `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The ICANN section of the Public Suffix List (${source}), VERSION ${version}: its rules alone, in punycode, one a line, with a newline before the first and after the last. Written by scripts/public-suffixes.ts; never edited by hand. */
export const publicSuffixRules = \`
${rules.join("\n")}
\`;
`
);
console.log(`${rules.length} rules, VERSION ${version}`);
