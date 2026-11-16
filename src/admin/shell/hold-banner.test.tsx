import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as en } from "../../../locales/en/messages.ts";
import { HoldBanner } from "./hold-banner.tsx";

const i18n = createMessages("en", en);

function banner(onEnd: (() => void) | undefined): string {
  return renderToStaticMarkup(
    <MessagesProvider i18n={i18n}>
      <HoldBanner onEnd={onEnd} pending={false} />
    </MessagesProvider>
  );
}

describe("the notification hold's banner", () => {
  test("says notifications are held since the import, with the button that resumes them for a role that may", () => {
    const html = banner(() => undefined);
    expect(html).toContain('data-slot="hold-banner"');
    expect(html).toContain(i18n._("app_hold_banner"));
    expect(html).toContain(i18n._("app_hold_end"));
    expect(html).toContain('data-slot="end-hold"');
  });

  test("shows a role that may not end the hold no button", () => {
    const html = banner(undefined);
    expect(html).toContain('data-slot="hold-banner"');
    expect(html).not.toContain('data-slot="end-hold"');
  });
});
