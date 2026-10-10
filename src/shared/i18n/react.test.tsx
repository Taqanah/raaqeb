import { describe, expect, test } from "bun:test";
import { setupI18n } from "@lingui/core";
import { renderToString } from "react-dom/server";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { createMessages } from "./messages.ts";
import { MessagesProvider, useMessages } from "./react.tsx";

function Title() {
  const { locale, t } = useMessages();
  return <h1 lang={locale}>{t("app_name")}</h1>;
}

describe("messages in a component", () => {
  test("the hook answers the provider's locale and translates by id", () => {
    const html = renderToString(
      <MessagesProvider i18n={createMessages("ar", ar)}>
        <Title />
      </MessagesProvider>
    );
    expect(html).toBe('<h1 lang="ar">راقب</h1>');
  });

  test("a provider holding a locale Raaqeb does not ship fails loudly", () => {
    const foreign = setupI18n({ locale: "fr", messages: { fr: {} } });
    expect(() =>
      renderToString(
        <MessagesProvider i18n={foreign}>
          <Title />
        </MessagesProvider>
      )
    ).toThrow("fr");
  });

  test("the hook outside a provider fails loudly instead of rendering an id", () => {
    expect(() => renderToString(<Title />)).toThrow();
  });
});
