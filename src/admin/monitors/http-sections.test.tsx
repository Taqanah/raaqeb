import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { noCredentials } from "@/shared/schemas/credentials.ts";
import type { CaptureMode } from "@/shared/schemas/monitor.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { draftOf } from "./draft.ts";
import { CaptureSection } from "./http-sections.tsx";

const noop = () => undefined;
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
