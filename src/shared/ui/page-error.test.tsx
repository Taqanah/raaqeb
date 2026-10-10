import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { fallbackCatalog } from "@/shared/i18n/fallback.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { publicCatalog } from "@/shared/i18n/public.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as arabic } from "../../../locales/ar/messages.ts";
import { messages as english } from "../../../locales/en/messages.ts";
import { DocumentError } from "./page-error.tsx";

describe("the notice a failed page shows", () => {
  test("in a document whose own read failed, with no catalog of its own, speaks words, never message ids", () => {
    for (const [locale, compiled] of [
      ["ar", arabic],
      ["en", english],
    ] as const) {
      const html = renderToString(
        <MessagesProvider
          i18n={createMessages(locale, fallbackCatalog(locale))}
        >
          <DocumentError />
        </MessagesProvider>
      );
      expect(html).not.toContain("app_");
      expect(html).toContain(String(compiled.app_error_title));
      expect(html).toContain(String(compiled.app_try_again));
    }
  });

  test("in a status page's document, which inlines the public part of the catalog, speaks words too", () => {
    const html = renderToString(
      <MessagesProvider i18n={createMessages("ar", publicCatalog(arabic))}>
        <DocumentError />
      </MessagesProvider>
    );
    expect(html).not.toContain("app_");
    expect(html).toContain(String(arabic.app_error_description));
  });
});
