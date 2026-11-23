import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMessages } from "@/shared/i18n/messages.ts";
import { MessagesProvider } from "@/shared/i18n/react.tsx";
import { messages as ar } from "../../../locales/ar/messages.ts";
import { messages as en } from "../../../locales/en/messages.ts";
import { ContentField, ContentInputs, ContentList } from "./content.tsx";

const i18n = createMessages("en", en);
const arabic = createMessages("ar", ar);
const required = i18n._("app_required");
const optional = i18n._("app_optional");
const noop = () => undefined;
const describedBy = /aria-describedby="([^"]*)"/g;
const hintId = /id="([^"]+)"[^>]*>Visitors read it\.</;
const refusalId = /id="([^"]+)"[^>]*>Type a title\.</;

function field(error?: string): string {
  return renderToStaticMarkup(
    <MessagesProvider i18n={i18n}>
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

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <MessagesProvider i18n={i18n}>{node}</MessagesProvider>
  );
}

describe("a content field's marks on its inputs", () => {
  test("the install language's input is marked required and the other locale's optional", () => {
    const html = render(
      <ContentField
        id="name"
        label="Name"
        max={100}
        onChange={noop}
        required="ar"
        value={{ ar: "", en: "" }}
      />
    );
    expect(html.split(required)).toHaveLength(2);
    expect(html.split(optional)).toHaveLength(2);
    expect(html.indexOf(required)).toBeLessThan(html.indexOf(optional));
  });

  test("optional content, empty in every locale, marks no input required", () => {
    const html = render(
      <ContentField
        id="description"
        label="Description"
        max={100}
        onChange={noop}
        optional
        required="ar"
        value={{ ar: "", en: "" }}
      />
    );
    expect(html).not.toContain(required);
  });

  test("a name either locale may hold alone marks both inputs optional and none required", () => {
    const html = render(
      <ContentField
        id="name"
        independent
        label="Name"
        max={100}
        onChange={noop}
        required="ar"
        value={{ ar: "", en: "" }}
      />
    );
    expect(html).not.toContain(required);
    expect(html.split(optional)).toHaveLength(3);
  });

  test("compact inputs name the install language's input required in its label and placeholder", () => {
    const html = render(
      <ContentInputs
        id="row"
        invalid={false}
        label="Name"
        max={100}
        onChange={noop}
        required="en"
        value={{ ar: "", en: "" }}
      />
    );
    expect(html).toContain(`aria-label="Name · English · ${required}"`);
    expect(html).toContain(`placeholder="Name · English · ${required}"`);
    expect(html).toContain(`aria-label="Name · العربية · ${optional}"`);
  });
});

describe("a list of content", () => {
  test('isolates each name and separates them with the locale\'s comma, so no Arabic "and" touches a Latin name', () => {
    expect(
      renderToStaticMarkup(
        <MessagesProvider i18n={arabic}>
          <ContentList
            contents={[{ ar: "الموقع" }, { ar: "API" }, { ar: "الدفع" }]}
          />
        </MessagesProvider>
      )
    ).toBe("<bdi>الموقع</bdi>، <bdi>API</bdi>، <bdi>الدفع</bdi>");
  });
});
