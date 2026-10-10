import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Token } from "./token.tsx";

describe("the token component", () => {
  test("renders a machine token as an isolated left-to-right run in the monospace face", () => {
    const html = renderToStaticMarkup(
      <Token>https://example.test/health</Token>
    );
    expect(html).toStartWith("<bdi ");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("font-mono");
    expect(html).toContain("https://example.test/health");
  });

  test("keeps a caller's classes and attributes", () => {
    const html = renderToStaticMarkup(
      <Token className="text-xs" title="HTTP 503">
        503
      </Token>
    );
    expect(html).toContain("text-xs");
    expect(html).toContain("font-mono");
    expect(html).toContain('title="HTTP 503"');
  });

  test("the direction cannot be overridden: a token is always left to right", () => {
    const html = renderToStaticMarkup(<Token dir="rtl">abc</Token>);
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain('dir="rtl"');
  });
});
