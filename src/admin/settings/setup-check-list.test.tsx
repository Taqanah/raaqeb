import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { SetupCheckList } from "./setup-check-list.tsx";

const verdictStart = /data-variant="(?:up|down)"/;
const svgTag = /<svg/g;

/** Each check's verdict badge, from its variant to its end. */
function verdicts(): string[] {
  const html = renderToStaticMarkup(
    <MessagesProvider i18n={createMessages("ar", ar)}>
      <SetupCheckList
        checks={[
          { check: "email_channel", passed: true },
          {
            check: "data_directory_mode",
            mode: 0o755,
            onHostRoot: true,
            passed: false,
            path: "/var/lib/raaqeb",
            secrets: ["config.json"],
          },
        ]}
      />
    </MessagesProvider>
  );
  return html
    .split(verdictStart)
    .slice(1)
    .map((rest) => rest.split("</span>")[0] ?? "");
}

describe("the setup check's verdicts", () => {
  test("a passed and a failed check each show one icon, the badge's own mark", () => {
    const shown = verdicts();
    expect(shown).toHaveLength(2);
    for (const verdict of shown) {
      expect(verdict.match(svgTag)).toHaveLength(1);
      expect(verdict).toContain('data-slot="badge-mark"');
    }
  });
});
