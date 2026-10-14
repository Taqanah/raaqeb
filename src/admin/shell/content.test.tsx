import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as en } from "../../../locales/en/messages.ts";
import { ContentField } from "./content.tsx";

const noop = () => undefined;
const describedBy = /aria-describedby="([^"]*)"/g;
const hintId = /id="([^"]+)"[^>]*>Visitors read it\.</;
const refusalId = /id="([^"]+)"[^>]*>Type a title\.</;

function field(error?: string): string {
  return renderToStaticMarkup(
    <MessagesProvider i18n={createMessages("en", en)}>
      <ContentField
        description="Visitors read it."
        error={error}
        id="title"
        label="Title"
        max={100}
        onChange={noop}
        required="ar"
        value={{ ar: "", en: "" }}
      />
    </MessagesProvider>
  );
}

describe("a content field's description of its inputs", () => {
  test("each locale's input is described by the field's hint, then its refusal", () => {
    const html = field("Type a title.");
    const hint = hintId.exec(html)?.[1];
    const refusal = refusalId.exec(html)?.[1];
    expect(hint).toBeDefined();
    expect(refusal).toBeDefined();
    expect([...html.matchAll(describedBy)].map((each) => each[1])).toEqual([
      `${hint} ${refusal}`,
      `${hint} ${refusal}`,
    ]);
  });

  test("with no refusal the inputs are described by the hint alone", () => {
    const html = field();
    const hint = hintId.exec(html)?.[1];
    expect(hint).toBeDefined();
    expect([...html.matchAll(describedBy)].map((each) => each[1])).toEqual([
      hint,
      hint,
    ]);
  });
});
