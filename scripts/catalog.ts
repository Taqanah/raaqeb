/**
 * `bun run catalog` and `bun run catalog:check`: the two catalog tools Raaqeb
 * owns (ADR-0003). Both read locales/<locale>/messages.po and refuse
 * a message that lacks the explicit-id comment, an id outside the snake_case
 * shape or the area list, an empty translation, an id present in one locale
 * only, or a plural missing a category its locale requires. `write` then
 * generates locales/message-ids.ts and runs `lingui compile --strict`;
 * `check` fails when the generated file is stale, so the gate never passes on
 * an id the code cannot see. Both then write locales/fallback.ts, the error
 * notice's words from each compiled catalog.
 */

import { errorNoticeIds } from "@/shared/i18n/messages.ts";

/** The first segment of every message id: the area of the interface it belongs to. */
export const areaPrefixes = [
  "app",
  "auth",
  "channel",
  "component",
  "incident",
  "maintenance",
  "monitor",
  "onboarding",
  "page",
  "public",
  "reason",
  "setting",
  "subscription",
] as const;

export interface CatalogMessage {
  /** Whether the entry carries the `js-lingui-explicit-id` comment. */
  readonly explicit: boolean;
  readonly id: string;
  /** The line of `msgid` in the PO file, for reports. */
  readonly line: number;
  readonly text: string;
}

export interface Catalog {
  readonly locale: string;
  readonly messages: readonly CatalogMessage[];
}

const explicitIdComment = "js-lingui-explicit-id";
const idShape = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const quoted = /^"(.*)"$/;
const pluralStart = /\{\s*\w+\s*,\s*(plural|selectordinal)\s*,/g;
const space = /\s/;
const keyEnd = /[\s{]/;
const escapes: Readonly<Record<string, string>> = {
  "\\\\": "\\",
  '\\"': '"',
  "\\n": "\n",
  "\\t": "\t",
};
const escapeSequence = /\\[\\"nt]/g;

function unquote(line: string): string {
  const match = quoted.exec(line);
  return (
    match?.[1]?.replace(escapeSequence, (found) => escapes[found] ?? found) ??
    ""
  );
}

/** The entry under construction while reading a PO file. */
interface Draft {
  explicit: boolean;
  field: "msgid" | "msgstr" | undefined;
  id: string | undefined;
  idLine: number;
  text: string;
}

function emptyDraft(): Draft {
  return {
    explicit: false,
    field: undefined,
    id: undefined,
    idLine: 0,
    text: "",
  };
}

/** Applies one PO line to the draft; a blank line ends the entry. */
function readLine(draft: Draft, line: string, lineNumber: number): void {
  if (line.startsWith("#. ")) {
    draft.explicit ||= line.slice(3).trim() === explicitIdComment;
  } else if (line.startsWith("msgid ")) {
    draft.field = "msgid";
    draft.id = unquote(line.slice(6));
    draft.idLine = lineNumber;
  } else if (line.startsWith("msgstr ")) {
    draft.field = "msgstr";
    draft.text = unquote(line.slice(7));
  } else if (line.startsWith('"') && draft.field === "msgid") {
    draft.id = (draft.id ?? "") + unquote(line);
  } else if (line.startsWith('"') && draft.field === "msgstr") {
    draft.text += unquote(line);
  }
}

/** Reads the entries of one PO file; the header entry (empty msgid) is skipped. */
export function parseCatalog(locale: string, po: string): Catalog {
  const messages: CatalogMessage[] = [];
  let draft = emptyDraft();
  const finish = () => {
    if (draft.id) {
      messages.push({
        explicit: draft.explicit,
        id: draft.id,
        line: draft.idLine,
        text: draft.text,
      });
    }
    draft = emptyDraft();
  };
  po.split("\n").forEach((raw, index) => {
    const line = raw.trimEnd();
    if (line === "") {
      finish();
    } else {
      readLine(draft, line, index + 1);
    }
  });
  finish();
  return { locale, messages };
}

/** The index just past the balanced `{...}` block that starts at or after `from`. */
function skipBlock(text: string, from: number): number {
  let i = text.indexOf("{", from);
  if (i === -1) {
    return text.length;
  }
  let depth = 0;
  do {
    const char = text.charAt(i);
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
    i += 1;
  } while (depth > 0 && i < text.length);
  return i;
}

const offsetToken = /^offset:\s*\d+/;

/** The category keys of one plural block starting right after its `plural,` token. */
function pluralKeys(text: string, from: number): string[] {
  const keys: string[] = [];
  // An ICU `offset:N` may lead the options; it is not a category.
  let i =
    from +
    (offsetToken.exec(text.slice(from).trimStart())?.[0].length ?? 0) +
    (text.slice(from).length - text.slice(from).trimStart().length);
  while (i < text.length) {
    while (i < text.length && space.test(text.charAt(i))) {
      i += 1;
    }
    if (i >= text.length || text.charAt(i) === "}") {
      break;
    }
    let key = "";
    while (i < text.length && !keyEnd.test(text.charAt(i))) {
      key += text.charAt(i);
      i += 1;
    }
    keys.push(key);
    i = skipBlock(text, i);
  }
  return keys;
}

/** The plural categories the locale requires that the ICU message lacks, per plural block. */
export function missingPluralCategories(
  locale: string,
  text: string
): string[] {
  const missing: string[] = [];
  for (const match of text.matchAll(pluralStart)) {
    const type = match[1] === "selectordinal" ? "ordinal" : "cardinal";
    const required = new Intl.PluralRules(locale, { type }).resolvedOptions()
      .pluralCategories;
    const present = new Set(pluralKeys(text, match.index + match[0].length));
    missing.push(...required.filter((category) => !present.has(category)));
  }
  return missing;
}

/** The problems of one message on its own: id shape and area, the comment, the text, the plurals. */
function messageProblems(locale: string, message: CatalogMessage): string[] {
  const problems: string[] = [];
  const at = `${locale}:${message.line}: ${message.id}`;
  if (!message.explicit) {
    problems.push(`${at} lacks the #. ${explicitIdComment} comment`);
  }
  const area = message.id.split("_")[0] ?? "";
  if (!idShape.test(message.id)) {
    problems.push(`${at} is not snake_case with an area prefix`);
  } else if (!(areaPrefixes as readonly string[]).includes(area)) {
    problems.push(
      `${at} starts with ${area}, not an area (${areaPrefixes.join(", ")})`
    );
  }
  if (message.text === "") {
    problems.push(`${at} has no text`);
  }
  const missing = missingPluralCategories(locale, message.text);
  if (missing.length > 0) {
    problems.push(`${at} lacks the plural categories ${missing.join(", ")}`);
  }
  return problems;
}

/** Every problem across the catalogs, as `<locale>:<line>: <problem>` lines; empty when clean. */
export function lintCatalogs(catalogs: readonly Catalog[]): string[] {
  const problems: string[] = [];
  for (const { locale, messages } of catalogs) {
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id)) {
        problems.push(
          `${locale}:${message.line}: ${message.id} is declared twice`
        );
      } else {
        seen.add(message.id);
        problems.push(...messageProblems(locale, message));
      }
    }
  }
  const every = [
    ...new Set(catalogs.flatMap((c) => c.messages.map((m) => m.id))),
  ].toSorted();
  for (const { locale, messages } of catalogs) {
    const own = new Set(messages.map((m) => m.id));
    problems.push(
      ...every
        .filter((id) => !own.has(id))
        .map((id) => `${locale}: ${id} is missing`)
    );
  }
  return problems;
}

/** The contents of locales/message-ids.ts for the catalog's ids. */
export function messageIdUnion(catalog: Catalog): string {
  const ids = catalog.messages
    .map((m) => JSON.stringify(m.id))
    .toSorted()
    .join(" | ");
  return `// Generated by \`bun run catalog\` from locales/${catalog.locale}/messages.po; do not edit.
export type MessageId = ${ids};

declare module "@lingui/core" {
  interface Register {
    messageIds: MessageId;
  }
}
`;
}

/** The contents of locales/fallback.ts: the error notice's words from each compiled catalog. */
export function fallbackFile(
  compiled: Readonly<Record<string, Record<string, unknown>>>
): string {
  const words = Object.fromEntries(
    Object.entries(compiled).map(([locale, messages]) => [
      locale,
      Object.fromEntries(errorNoticeIds.map((id) => [id, messages[id]])),
    ])
  );
  return `// Generated by \`bun run catalog\` from the compiled catalogs; do not edit.
import type { Messages } from "@lingui/core";

/** The error notice's words in each locale, for a document whose own read failed. */
export const fallbackMessages: Readonly<Record<"ar" | "en", Messages>> = ${JSON.stringify(words)};
`;
}

const locales = ["ar", "en"];
const unionFile = "locales/message-ids.ts";
const fallbackPath = "locales/fallback.ts";

async function readCatalogs(root: string): Promise<Catalog[]> {
  return await Promise.all(
    locales.map(async (locale) =>
      parseCatalog(
        locale,
        await Bun.file(`${root}/locales/${locale}/messages.po`).text()
      )
    )
  );
}

function compile(root: string): number {
  const run = Bun.spawnSync(
    ["bun", "--bun", `${root}/node_modules/.bin/lingui`, "compile", "--strict"],
    { cwd: root, stdio: ["inherit", "inherit", "inherit"] }
  );
  return run.exitCode;
}

async function main(command: string | undefined): Promise<number> {
  if (command !== "check" && command !== "write") {
    process.stderr.write("usage: bun scripts/catalog.ts check | write\n");
    return 2;
  }
  const root = process.cwd();
  const catalogs = await readCatalogs(root);
  const problems = lintCatalogs(catalogs);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }
  const source = catalogs.find((c) => c.locale === "ar");
  if (!source) {
    process.stderr.write("no Arabic catalog\n");
    return 1;
  }
  const union = messageIdUnion(source);
  const target = Bun.file(`${root}/${unionFile}`);
  const current = (await target.exists()) ? await target.text() : "";
  if (command === "write") {
    if (current !== union) {
      await Bun.write(target, union);
      process.stdout.write(`wrote ${unionFile}\n`);
    }
  } else if (current !== union) {
    process.stderr.write(`${unionFile} is out of date; run bun run catalog\n`);
    return 1;
  }
  const compiled = compile(root);
  if (compiled !== 0) {
    return compiled;
  }
  const messages = await Promise.all(
    locales.map(
      async (locale) =>
        [
          locale,
          (await import(`${root}/locales/${locale}/messages.ts`)).messages,
        ] as const
    )
  );
  const fallback = fallbackFile(Object.fromEntries(messages));
  const fallbackTarget = Bun.file(`${root}/${fallbackPath}`);
  // Written in both modes, as lingui compile writes the catalogs: generated, never checked in.
  if (
    !(await fallbackTarget.exists()) ||
    (await fallbackTarget.text()) !== fallback
  ) {
    await Bun.write(fallbackTarget, fallback);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv[2]));
}
