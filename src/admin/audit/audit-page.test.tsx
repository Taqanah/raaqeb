import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { Locale } from "@/shared/i18n/locale.ts";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { SidebarProvider } from "@/shared/ui/sidebar.tsx";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { AuditPage } from "./audit-page.tsx";

const noop = () => undefined;

function page(locale: Locale): string {
  const i18n =
    locale === "ar" ? createMessages("ar", ar) : createMessages("en", en);
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <SidebarProvider>
        <AuditPage
          clock={{ calendar: "gregorian", clock: "24h", timeZone: "UTC" }}
          now={Date.UTC(2026, 10, 23)}
          onFilter={noop}
          search={{}}
          view={{ actors: [], entries: [], more: false }}
        />
      </SidebarProvider>
    </MessagesProvider>
  );
}

describe("the audit page's intro", () => {
  test("says entries are kept for the retention and never less than 90 days, in English", () => {
    const html = page("en");
    expect(html).toContain("never less than 90 days");
    expect(html).not.toContain("past the retention period are deleted");
  });

  test("says entries are kept for the retention and never less than 90 days, in Arabic", () => {
    const html = page("ar");
    expect(html).toContain("90 يومًا");
    expect(html).not.toContain("يُحذف ما تجاوز مدة الاحتفاظ");
  });
});
