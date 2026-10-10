import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

const noop = () => undefined;

describe("a free-text field's direction", () => {
  test("an empty field follows the page, since auto would read nothing as left to right", () => {
    for (const html of [
      renderToStaticMarkup(<Input dir="auto" onChange={noop} value="" />),
      renderToStaticMarkup(<Textarea dir="auto" onChange={noop} value="" />),
    ]) {
      expect(html).not.toContain("dir=");
    }
  });

  test("a field with text takes the direction of its first strong letter", () => {
    for (const html of [
      renderToStaticMarkup(<Input dir="auto" onChange={noop} value="الموقع" />),
      renderToStaticMarkup(
        <Textarea dir="auto" onChange={noop} value="Shop" />
      ),
    ]) {
      expect(html).toContain('dir="auto"');
    }
  });

  test("a machine-token field stays left to right, empty or not", () => {
    expect(
      renderToStaticMarkup(<Input dir="ltr" onChange={noop} value="" />)
    ).toContain('dir="ltr"');
  });
});
