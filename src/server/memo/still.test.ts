import { describe, expect, test } from "bun:test";
import { stillDocument, withLocaleSwitch } from "./still.ts";

/** A document as Start renders a framed not-found: the theme script in the head, the app's preloads and scripts around the body. */
const rendered = [
  "<!DOCTYPE html><html><head>",
  '<link rel="modulepreload" href="/assets/index-a.js"/>',
  '<link rel="preload" as="font" href="/assets/rubik-b.woff2" type="font/woff2"/>',
  '<link rel="stylesheet" href="/assets/index-c.css"/>',
  "<script>document.documentElement.dataset.theme='dark'</script>",
  "<title>Not found</title></head><body>",
  '<main data-slot="view-missing"><a data-slot="page-locale" href="/en">English</a></main>',
  "<script>(function(){sessionStorage})()</script>",
  '<script data-tsr-stream-part="">$_TSR.router={}</script>',
  '<script type="module" async src="/assets/index-a.js"></script>',
  "</body></html>",
].join("");

function page(): Response {
  return new Response(rendered, {
    headers: { "content-type": "text/html; charset=utf-8" },
    status: 404,
  });
}

describe("a still document", () => {
  test("keeps what paints it, its head's own script, stylesheet and fonts, and drops every script and preload the app hydrates with", async () => {
    const still = await stillDocument(page()).text();
    expect(still).toContain(
      "<script>document.documentElement.dataset.theme='dark'</script>"
    );
    expect(still).toContain('rel="stylesheet" href="/assets/index-c.css"');
    expect(still).toContain('as="font" href="/assets/rubik-b.woff2"');
    expect(still).toContain('<main data-slot="view-missing">');
    expect(still).not.toContain("modulepreload");
    expect(still).not.toContain("$_TSR");
    expect(still).not.toContain("sessionStorage");
    expect(still).not.toContain('type="module"');
  });

  test("keeps the render's status and headers", () => {
    const still = stillDocument(page());
    expect(still.status).toBe(404);
    expect(still.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("a still document's language switch", () => {
  test("leads to the address it is given, and nothing else changes", async () => {
    const switched = await withLocaleSwitch(
      page(),
      "/en/incidents/nope"
    ).text();
    expect(switched).toContain(
      '<a data-slot="page-locale" href="/en/incidents/nope">English</a>'
    );
    expect(switched.replace("/en/incidents/nope", "/en")).toBe(rendered);
  });
});
