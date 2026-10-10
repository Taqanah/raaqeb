import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailFrame, PreviewBody } from "./preview.tsx";

const tags = /<[^>]+>/g;
const link =
  "https://status.example.test/admin/monitors/00000000-0000-7000-8000-000000000000";
const body = `المراقبة: الموقع\nالرابط: ${link}`;

describe("a notification preview's body", () => {
  test("isolates each link left to right, so a wrapped link keeps its hyphens in place", () => {
    const html = renderToStaticMarkup(
      <PreviewBody body={body} machine={false} />
    );
    expect(html).toContain(`<bdi class="break-all" dir="ltr">${link}</bdi>`);
  });

  test("shows the text exactly as it is sent", () => {
    const html = renderToStaticMarkup(
      <PreviewBody body={body} machine={false} />
    );
    expect(html.replace(tags, "")).toBe(body);
  });

  test("each link shows as the words that open it on a line of its own after the text, its address on hover", () => {
    const html = renderToStaticMarkup(
      <PreviewBody
        body="المراقبة: الموقع"
        links={[
          { url: link, words: "فتح المراقبة" },
          { url: `${link}/x`, words: "فتح حادثة" },
        ]}
        machine={false}
      />
    );
    expect(html.replace(tags, "")).toBe(
      "المراقبة: الموقع\nفتح المراقبة\nفتح حادثة"
    );
    expect(html).toContain(`title="${link}">فتح المراقبة</span>`);
  });

  test("an email's HTML part shows in a frame that runs no script and opens nothing, named by its subject", () => {
    const html = renderToStaticMarkup(
      <EmailFrame html="<p>المراقبة متعطّلة.</p>" title="API: متعطّل" />
    );
    expect(html).toContain('sandbox="allow-same-origin"');
    expect(html).not.toContain("allow-scripts");
    expect(html).toContain('title="API: متعطّل"');
  });

  test("a machine body is left whole, left to right", () => {
    const json = '{"url": "https://x.test/a-b"}';
    const html = renderToStaticMarkup(<PreviewBody body={json} machine />);
    expect(html).not.toContain("<bdi");
    expect(html).toContain('dir="ltr"');
  });
});
