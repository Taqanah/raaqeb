import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { LanguageForm } from "./language-form.tsx";

function languageStep(): string {
  return renderToStaticMarkup(
    <MessagesProvider i18n={createMessages("ar", ar)}>
      <LanguageForm nextPath="/onboarding/database" steps={3} />
    </MessagesProvider>
  );
}

describe("onboarding's language step", () => {
  test("offers each language once, as its card, with no language links under the card", () => {
    const html = languageStep();
    expect(html).toContain('name="locale"');
    expect(html).not.toContain('href="?locale=en"');
    expect(html).not.toContain('href="?locale=ar"');
  });
});
