import { describe, expect, test } from "bun:test";
import { messages as arabic } from "../locales/ar/messages.ts";
import { messages as english } from "../locales/en/messages.ts";
import {
  areaPrefixes,
  fallbackFile,
  lintCatalogs,
  messageIdUnion,
  missingPluralCategories,
  parseCatalog,
} from "./catalog.ts";

const header = `msgid ""
msgstr ""
"Language: ar\\n"
"Content-Type: text/plain; charset=utf-8\\n"
`;

function po(entries: string): string {
  return `${header}\n${entries}`;
}

const explicit = "#. js-lingui-explicit-id";

describe("reading a message catalog", () => {
  test("the header entry is not a message", () => {
    expect(parseCatalog("ar", header).messages).toEqual([]);
  });

  test("an entry has its id, its text, its line and whether its id is explicit", () => {
    const catalog = parseCatalog(
      "ar",
      po(
        `${explicit}\nmsgid "app_name"\nmsgstr "راقب"\n\nmsgid "app_other"\nmsgstr "x"\n`
      )
    );
    expect(catalog.messages).toEqual([
      { explicit: true, id: "app_name", line: 7, text: "راقب" },
      { explicit: false, id: "app_other", line: 10, text: "x" },
    ]);
  });

  test("a multi-line text and escaped quotes are read whole", () => {
    const catalog = parseCatalog(
      "en",
      po(
        `${explicit}\nmsgid "app_note"\nmsgstr ""\n"first \\"quoted\\" line\\n"\n"second line"\n`
      )
    );
    expect(catalog.messages[0]?.text).toBe('first "quoted" line\nsecond line');
  });

  test("another extracted comment does not make an id explicit", () => {
    const catalog = parseCatalog(
      "en",
      po(`#. placeholder {0}: name\nmsgid "app_name"\nmsgstr "Raaqeb"\n`)
    );
    expect(catalog.messages[0]?.explicit).toBe(false);
  });

  test("a file without a trailing blank line still yields its last entry", () => {
    const catalog = parseCatalog(
      "en",
      `${header}\n${explicit}\nmsgid "app_name"\nmsgstr "Raaqeb"`
    );
    expect(catalog.messages.map((m) => m.id)).toEqual(["app_name"]);
  });

  test("a translator comment and a flag do not make an id explicit", () => {
    const catalog = parseCatalog(
      "en",
      po(`# a translator note\n#, fuzzy\nmsgid "app_name"\nmsgstr "Raaqeb"\n`)
    );
    expect(catalog.messages[0]?.explicit).toBe(false);
  });
});

describe("plural categories", () => {
  test("Arabic needs all six", () => {
    expect(
      missingPluralCategories(
        "ar",
        "{count, plural, one {مراقبة واحدة} other {# مراقبة}}"
      )
    ).toEqual(["zero", "two", "few", "many"]);
  });

  test("English needs one and other", () => {
    expect(
      missingPluralCategories("en", "{count, plural, other {# monitors}}")
    ).toEqual(["one"]);
  });

  test("a complete plural is missing nothing", () => {
    expect(
      missingPluralCategories(
        "ar",
        "{count, plural, zero {لا مراقبات} one {مراقبة واحدة} two {مراقبتان} few {# مراقبات} many {# مراقبة} other {# مراقبة}}"
      )
    ).toEqual([]);
  });

  test("an exact match such as =0 does not stand in for a category", () => {
    expect(
      missingPluralCategories(
        "en",
        "{count, plural, =0 {none} other {# monitors}}"
      )
    ).toEqual(["one"]);
  });

  test("a nested block inside a category does not end the plural early", () => {
    expect(
      missingPluralCategories(
        "en",
        "{count, plural, one {{name} has # monitor} other {{name} has # monitors}}"
      )
    ).toEqual([]);
  });

  test("an ICU offset is not a category and does not hide the one after it", () => {
    expect(
      missingPluralCategories(
        "en",
        "{count, plural, offset:1 one {# other} other {# others}}"
      )
    ).toEqual([]);
    expect(
      missingPluralCategories(
        "ar",
        "{count, plural, offset: 2 other {# others}}"
      )
    ).toEqual(["zero", "one", "two", "few", "many"]);
  });

  test("a message without a plural is missing nothing", () => {
    expect(missingPluralCategories("ar", "راقب {name}")).toEqual([]);
  });

  test("every plural block in a message is checked", () => {
    expect(
      missingPluralCategories(
        "en",
        "{a, plural, one {# day} other {# days}} and {b, plural, other {# hours}}"
      )
    ).toEqual(["one"]);
  });

  test("an ordinal uses the ordinal categories", () => {
    expect(
      missingPluralCategories(
        "en",
        "{n, selectordinal, one {#st} two {#nd} other {#th}}"
      )
    ).toEqual(["few"]);
  });
});

describe("linting the catalogs", () => {
  const ar = parseCatalog(
    "ar",
    po(`${explicit}\nmsgid "app_name"\nmsgstr "راقب"\n`)
  );
  const en = parseCatalog(
    "en",
    po(`${explicit}\nmsgid "app_name"\nmsgstr "Raaqeb"\n`)
  );

  test("two complete catalogs have no problems", () => {
    expect(lintCatalogs([ar, en])).toEqual([]);
  });

  test("an id without the explicit-id comment is a problem, because Lingui would hash it", () => {
    const bad = parseCatalog("en", po(`msgid "app_name"\nmsgstr "Raaqeb"\n`));
    expect(lintCatalogs([ar, bad])).toEqual([
      "en:6: app_name lacks the #. js-lingui-explicit-id comment",
    ]);
  });

  test("an empty translation is a problem in every locale", () => {
    const bad = parseCatalog(
      "ar",
      po(`${explicit}\nmsgid "app_name"\nmsgstr ""\n`)
    );
    expect(lintCatalogs([bad, en])).toEqual(["ar:7: app_name has no text"]);
  });

  test("an id outside the snake_case shape with an area prefix is a problem", () => {
    const bad = parseCatalog(
      "en",
      po(
        `${explicit}\nmsgid "app_name"\nmsgstr "Raaqeb"\n\n${explicit}\nmsgid "appName"\nmsgstr "x"\n\n${explicit}\nmsgid "banner_title"\nmsgstr "x"\n\n${explicit}\nmsgid "app"\nmsgstr "x"\n`
      )
    );
    const arToo = parseCatalog(
      "ar",
      po(
        `${explicit}\nmsgid "app_name"\nmsgstr "راقب"\n\n${explicit}\nmsgid "appName"\nmsgstr "x"\n\n${explicit}\nmsgid "banner_title"\nmsgstr "x"\n\n${explicit}\nmsgid "app"\nmsgstr "x"\n`
      )
    );
    expect(lintCatalogs([arToo, bad])).toEqual([
      "ar:11: appName is not snake_case with an area prefix",
      "ar:15: banner_title starts with banner, not an area (app, auth, channel, component, incident, maintenance, monitor, onboarding, page, public, reason, setting, subscription)",
      "ar:19: app is not snake_case with an area prefix",
      "en:11: appName is not snake_case with an area prefix",
      "en:15: banner_title starts with banner, not an area (app, auth, channel, component, incident, maintenance, monitor, onboarding, page, public, reason, setting, subscription)",
      "en:19: app is not snake_case with an area prefix",
    ]);
  });

  test("an id in one locale only is a problem for the locale that lacks it", () => {
    const more = parseCatalog(
      "en",
      po(
        `${explicit}\nmsgid "app_name"\nmsgstr "Raaqeb"\n\n${explicit}\nmsgid "app_extra"\nmsgstr "x"\n`
      )
    );
    expect(lintCatalogs([ar, more])).toEqual(["ar: app_extra is missing"]);
  });

  test("a plural missing a category names the locale, the line and the categories", () => {
    const arPlural = parseCatalog(
      "ar",
      po(
        `${explicit}\nmsgid "monitor_count"\nmsgstr "{count, plural, one {مراقبة} other {# مراقبة}}"\n`
      )
    );
    const enPlural = parseCatalog(
      "en",
      po(
        `${explicit}\nmsgid "monitor_count"\nmsgstr "{count, plural, one {# monitor} other {# monitors}}"\n`
      )
    );
    expect(lintCatalogs([arPlural, enPlural])).toEqual([
      "ar:7: monitor_count lacks the plural categories zero, two, few, many",
    ]);
  });

  test("a duplicate id is a problem", () => {
    const dup = parseCatalog(
      "en",
      po(
        `${explicit}\nmsgid "app_name"\nmsgstr "Raaqeb"\n\n${explicit}\nmsgid "app_name"\nmsgstr "Again"\n`
      )
    );
    expect(lintCatalogs([ar, dup])).toEqual([
      "en:11: app_name is declared twice",
    ]);
  });

  test("the area list is sorted and holds the areas of the layout", () => {
    expect([...areaPrefixes]).toEqual([...areaPrefixes].toSorted());
    expect(areaPrefixes).toContain("monitor");
    expect(areaPrefixes).toContain("reason");
  });
});

describe("the generated id union", () => {
  test("lists every id of the catalog, sorted, and narrows Lingui's ids", () => {
    const catalog = parseCatalog(
      "ar",
      po(
        `${explicit}\nmsgid "monitor_name"\nmsgstr "x"\n\n${explicit}\nmsgid "app_name"\nmsgstr "y"\n`
      )
    );
    expect(
      messageIdUnion(catalog)
    ).toBe(`// Generated by \`bun run catalog\` from locales/ar/messages.po; do not edit.
export type MessageId = "app_name" | "monitor_name";

declare module "@lingui/core" {
  interface Register {
    messageIds: MessageId;
  }
}
`);
  });
});

describe("the catalog command", () => {
  const root = new URL("../", import.meta.url).pathname;

  test("check exits 0 on the checked-in catalogs, which are clean and whose id union is current", () => {
    const run = Bun.spawnSync(["bun", "scripts/catalog.ts", "check"], {
      cwd: root,
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("check fails, naming the problem, when a catalog is broken", async () => {
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    try {
      await Bun.$`cp -r ${root}locales ${root}lingui.config.ts ${root}package.json ${dir}/`.quiet();
      await Bun.$`ln -s ${root}node_modules ${dir}/node_modules`.quiet();
      await Bun.write(
        `${dir}/locales/en/messages.po`,
        (await Bun.file(`${dir}/locales/en/messages.po`).text()).replace(
          'msgstr "Raaqeb"',
          'msgstr ""'
        )
      );
      const run = Bun.spawnSync(["bun", `${root}scripts/catalog.ts`, "check"], {
        cwd: dir,
      });
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain("en:10: app_name has no text");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("check fails when the id union is stale and says what writes it", async () => {
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    try {
      await Bun.$`cp -r ${root}locales ${root}lingui.config.ts ${root}package.json ${dir}/`.quiet();
      await Bun.$`ln -s ${root}node_modules ${dir}/node_modules`.quiet();
      await Bun.write(`${dir}/locales/message-ids.ts`, "// stale\n");
      const run = Bun.spawnSync(["bun", `${root}scripts/catalog.ts`, "check"], {
        cwd: dir,
      });
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain(
        "locales/message-ids.ts is out of date; run bun run catalog"
      );
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("write regenerates the union, compiles both catalogs and writes the error notice's fallback words", async () => {
    const dir = (await Bun.$`mktemp -d`.text()).trim();
    try {
      await Bun.$`cp -r ${root}locales ${root}lingui.config.ts ${root}package.json ${dir}/`.quiet();
      await Bun.$`ln -s ${root}node_modules ${dir}/node_modules`.quiet();
      await Bun.$`rm -f ${dir}/locales/message-ids.ts ${dir}/locales/ar/messages.ts ${dir}/locales/en/messages.ts ${dir}/locales/fallback.ts`.quiet();
      const run = Bun.spawnSync(["bun", `${root}scripts/catalog.ts`, "write"], {
        cwd: dir,
      });
      expect(run.exitCode).toBe(0);
      expect(await Bun.file(`${dir}/locales/message-ids.ts`).text()).toBe(
        await Bun.file(`${root}locales/message-ids.ts`).text()
      );
      expect(await Bun.file(`${dir}/locales/ar/messages.ts`).exists()).toBe(
        true
      );
      expect(await Bun.file(`${dir}/locales/en/messages.ts`).exists()).toBe(
        true
      );
      expect(await Bun.file(`${dir}/locales/fallback.ts`).text()).toBe(
        fallbackFile({ ar: arabic, en: english })
      );
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("a command other than check or write exits 2", () => {
    const run = Bun.spawnSync(["bun", "scripts/catalog.ts", "lint"], {
      cwd: root,
    });
    expect(run.exitCode).toBe(2);
  });
});

describe("the error notice's fallback words", () => {
  test("hold the notice's words in each locale, as the compiled catalogs say them, and nothing else", () => {
    const file = fallbackFile({ ar: arabic, en: english });
    for (const compiled of [arabic, english]) {
      for (const id of [
        "app_error_title",
        "app_error_description",
        "app_try_again",
      ]) {
        expect(file).toContain(
          `${JSON.stringify(id)}:${JSON.stringify(compiled[id])}`
        );
      }
    }
    expect(file).not.toContain("app_name");
  });
});
