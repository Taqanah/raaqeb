import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./input.tsx";

describe("the token input", () => {
  test("a machine token is typed left to right in the monospace face, never spell-checked", () => {
    const html = renderToStaticMarkup(
      <Input name="url" readOnly value="https://example.test" variant="token" />
    );
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("font-mono");
    expect(html).toContain('spellCheck="false"');
  });

  test("the direction cannot be overridden: a token input is always left to right", () => {
    const html = renderToStaticMarkup(
      <Input dir="auto" readOnly value="" variant="token" />
    );
    expect(html).toContain('dir="ltr"');
  });

  test("a plain input keeps the proportional face and its caller's direction", () => {
    const html = renderToStaticMarkup(<Input dir="auto" readOnly value="x" />);
    expect(html).not.toContain("font-mono");
    expect(html).toContain('dir="auto"');
  });
});

const hintThenUnit = /aria-describedby="hint [^"]+"/;
const unitSpan = /<span[^>]*id="([^"]+)"[^>]*>ثانية<\/span>/;

describe("a number's unit", () => {
  test("shows at the field's end and is read with the field", () => {
    const html = renderToStaticMarkup(
      <Input
        inputMode="numeric"
        name="timeout"
        readOnly
        unit="ثانية"
        value="10"
      />
    );
    const unitId = unitSpan.exec(html)?.[1];
    expect(unitId).toBeDefined();
    expect(html).toContain(`aria-describedby="${unitId}"`);
  });

  test("keeps the caller's description beside the unit", () => {
    const html = renderToStaticMarkup(
      <Input aria-describedby="hint" readOnly unit="يوم" value="7" />
    );
    expect(html).toMatch(hintThenUnit);
  });

  test("a field without a unit has no wrapper and no unit", () => {
    const html = renderToStaticMarkup(<Input readOnly value="7" />);
    expect(html).not.toContain('data-slot="input-group"');
    expect(html).not.toContain("aria-describedby");
  });
});
