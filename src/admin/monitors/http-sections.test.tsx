import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { noCredentials } from "@/shared/schemas/credentials.ts";
import type { CaptureMode } from "@/shared/schemas/monitor.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { draftOf, type MonitorDraft } from "./draft.ts";
import { CaptureSection, RequestSection } from "./http-sections.tsx";

const noop = () => undefined;
// An input's attributes in either order.
const passwordInput =
  /name="proxyPassword"[^>]*type="password"|type="password"[^>]*name="proxyPassword"/;
const i18n = createMessages("en", en);
const whatACaptureHolds = i18n._("monitor_field_capture_mode_hint");

function captureSection(captureMode: CaptureMode): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <CaptureSection
        draft={{ ...draftOf(undefined, noCredentials), captureMode }}
        errors={{}}
        onChoice={noop}
        onField={noop}
        onFlag={noop}
      />
    </MessagesProvider>
  );
}

describe("the line under the capture mode", () => {
  test("says what a capture holds while the mode keeps one", () => {
    expect(captureSection("on_failure")).toContain(whatACaptureHolds);
    expect(captureSection("always")).toContain(whatACaptureHolds);
  });

  test("says nothing of a capture's contents while capture is off, since none is kept", () => {
    expect(captureSection("off")).not.toContain(whatACaptureHolds);
  });
});

function requestSection(fields: Partial<MonitorDraft>): string {
  return renderToString(
    <MessagesProvider i18n={i18n}>
      <RequestSection
        draft={{ ...draftOf(undefined, noCredentials), ...fields }}
        errors={{}}
        onAddAssertion={noop}
        onAddHeader={noop}
        onChoice={noop}
        onField={noop}
        onFlag={noop}
        onRemoveAssertion={noop}
        onRemoveHeader={noop}
      />
    </MessagesProvider>
  );
}

const typedAddress = { proxy: "http://proxy.example.test:3128" };

describe("the request section's proxy", () => {
  test("asks for the address with the line that says it overrides the install's environment, and for no user name or password yet", () => {
    const html = requestSection({});
    expect(html).toContain('name="proxy"');
    expect(html).toContain(
      i18n._("monitor_field_proxy_hint").replaceAll("'", "&#x27;")
    );
    expect(html).not.toContain('name="proxyUser"');
    expect(html).not.toContain('name="proxyPassword"');
  });

  test("asks for the user name and the password once an address is typed, the password hidden", () => {
    const html = requestSection(typedAddress);
    expect(html).toContain('name="proxyUser"');
    expect(html).toContain('name="proxyPassword"');
    expect(html).toMatch(passwordInput);
  });

  test("says a stored proxy password is kept, and says nothing of one when none is stored", () => {
    const kept = `placeholder="${i18n._("monitor_secret_kept")}"`;
    expect(
      requestSection({ ...typedAddress, storedProxyAuth: true })
    ).toContain(kept);
    expect(requestSection(typedAddress)).not.toContain(kept);
  });
});
