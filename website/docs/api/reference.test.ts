import { describe, expect, test } from "bun:test";
import { openApiDocument } from "@/shared/api/openapi.ts";
import { apiLabels } from "./labels.ts";
import {
  operationMarkdown,
  operationsAt,
  schemaOutline,
  textSpans,
  webhookGroupOf,
  webhookMarkdown,
} from "./reference.ts";

const doc = openApiDocument();
const languageOfFile = /\.(\w+)\.mdx$/;
// What the outline writes for a schema it cannot read; a reason named "unknown" is quoted.
const bareUnknown = /(?<!")\bunknown\b(?!")/;
// A tag's attribute however it is quoted: path="…", path='…' or path={"…"}, among other attributes.
const operationTag = /<ApiOperation\b[^>]*?\bpath=\{?["']([^"']+)["']/g;
const webhookTag = /<ApiWebhook\b[^>]*?\bname=\{?["']([^"']+)["']/g;

/** The paths and webhooks each language's reference pages name, read from their MDX. */
async function namedByPages(): Promise<
  Map<string, { paths: string[]; webhooks: string[] }>
> {
  const dir = `${import.meta.dir}/../../content/docs/api`;
  const named = new Map<string, { paths: string[]; webhooks: string[] }>();
  for await (const file of new Bun.Glob("*.mdx").scan(dir)) {
    const language = file.match(languageOfFile)?.[1] ?? "ar";
    const text = await Bun.file(`${dir}/${file}`).text();
    const entry = named.get(language) ?? { paths: [], webhooks: [] };
    for (const m of text.matchAll(operationTag)) {
      entry.paths.push(m[1] ?? "");
    }
    for (const m of text.matchAll(webhookTag)) {
      entry.webhooks.push(m[1] ?? "");
    }
    named.set(language, entry);
  }
  return named;
}

describe("the API reference", () => {
  test("shows a heartbeat's GET, HEAD and POST as one entry", () => {
    const entries = operationsAt(doc, "/api/heartbeat/{token}");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.methods).toEqual(["get", "head", "post"]);
    expect(entries[0]?.paths).toEqual(["/api/heartbeat/{token}"]);
  });

  test("shows a badge's four addresses as one entry, with every address's path parameters", () => {
    const entries = operationsAt(doc, "/{locale}/badge.svg");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.paths).toEqual([
      "/badge.svg",
      "/{locale}/badge.svg",
      "/status/{slug}/badge.svg",
      "/{locale}/status/{slug}/badge.svg",
    ]);
    expect(entries[0]?.parameters.map((p) => p.name)).toEqual([
      "locale",
      "slug",
    ]);
  });

  test("keeps a subscription's confirm GET apart from its POST, since they answer differently", () => {
    const entries = operationsAt(doc, "/subscriptions/{token}/confirm");
    expect(entries.map((e) => e.methods)).toEqual([["get"], ["post"]]);
  });

  test("keeps the current month's history apart from one month's, since their summaries differ", () => {
    expect(operationsAt(doc, "/api/pages/{id}/history")).toHaveLength(1);
    expect(operationsAt(doc, "/api/pages/{id}/history")[0]?.paths).toEqual([
      "/api/pages/{id}/history",
    ]);
  });

  test("has no entry for a path the document does not have", () => {
    expect(operationsAt(doc, "/api/monitors")).toEqual([]);
  });

  test("gives each response its status, bodies and headers", () => {
    const [get] = operationsAt(doc, "/subscriptions/{token}/unsubscribe");
    expect(get?.responses.map((r) => r.status)).toEqual(["303"]);
    expect(get?.responses[0]?.headers).toEqual(["location"]);
    const [ingest] = operationsAt(doc, "/api/heartbeat/{token}");
    expect(ingest?.responses.map((r) => r.status)).toEqual([
      "200",
      "404",
      "503",
    ]);
    expect(ingest?.responses[0]?.bodies).toEqual([
      { mediaType: "text/plain", schema: { const: "OK", type: "string" } },
    ]);
  });

  test("shows the seven subscriber events as one entry, each with its own summary and description", () => {
    const group = webhookGroupOf(doc, "maintenance.started");
    expect(group?.webhooks.map((w) => w.name)).toEqual([
      "incident.published",
      "incident.updated",
      "maintenance.scheduled",
      "maintenance.rescheduled",
      "maintenance.started",
      "maintenance.completed",
      "maintenance.cancelled",
    ]);
    expect(new Set(group?.webhooks.map((w) => w.summary)).size).toBe(7);
    expect(new Set(group?.webhooks.map((w) => w.description)).size).toBe(7);
    expect(group?.requestBodies.map((b) => b.mediaType)).toEqual([
      "application/json",
    ]);
  });

  test("shows each notification type a webhook channel sends as its own entry", () => {
    const group = webhookGroupOf(doc, "monitor.down");
    expect(group?.webhooks.map((w) => w.name)).toEqual(["monitor.down"]);
    expect(group?.parameters.map((p) => p.name)).toEqual([
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]);
  });

  test("has no webhook the document does not send", () => {
    expect(webhookGroupOf(doc, "monitor.deleted")).toBeUndefined();
  });

  // English is complete; another language's pages land one at a time, and a page missing in one language is missing.
  test("names every path in the document on an English reference page", async () => {
    const paths = (await namedByPages()).get("en")?.paths ?? [];
    const shown = new Set(
      paths.flatMap((p) => operationsAt(doc, p).flatMap((e) => e.paths))
    );
    expect(Object.keys(doc.paths).filter((p) => !shown.has(p))).toEqual([]);
  });

  test("names every webhook in the document on an English reference page", async () => {
    const webhooks = (await namedByPages()).get("en")?.webhooks ?? [];
    const shown = new Set(
      webhooks.flatMap(
        (n) => webhookGroupOf(doc, n)?.webhooks.map((w) => w.name) ?? []
      )
    );
    expect(Object.keys(doc.webhooks).filter((n) => !shown.has(n))).toEqual([]);
  });

  test("names no path or webhook the document does not have, in any language", async () => {
    const named = await namedByPages();
    for (const { paths, webhooks } of named.values()) {
      expect(paths.filter((p) => operationsAt(doc, p).length === 0)).toEqual(
        []
      );
      expect(webhooks.filter((n) => !webhookGroupOf(doc, n))).toEqual([]);
    }
  });
});

describe("a schema's outline", () => {
  test("names a plain type", () => {
    expect(schemaOutline({ type: "string" })).toBe("string");
    expect(schemaOutline({ type: "integer" })).toBe("integer");
  });

  test("reads an enum as its values", () => {
    expect(schemaOutline({ enum: ["ok", "stale"], type: "string" })).toBe(
      '"ok" | "stale"'
    );
  });

  test("reads a const as its value", () => {
    expect(schemaOutline({ const: true, type: "boolean" })).toBe("true");
    expect(schemaOutline({ const: "OK", type: "string" })).toBe('"OK"');
  });

  test("reads a nullable value the same from a type list or a union", () => {
    expect(schemaOutline({ type: ["string", "null"] })).toBe("string | null");
    expect(
      schemaOutline({ anyOf: [{ type: "integer" }, { type: "null" }] })
    ).toBe("integer | null");
  });

  test("marks a field the object does not require as optional", () => {
    expect(
      schemaOutline({
        properties: { a: { type: "string" }, b: { type: "integer" } },
        required: ["a"],
        type: "object",
      })
    ).toBe("{\n  a: string;\n  b?: integer;\n}");
  });

  test("indents a nested object under its field", () => {
    expect(
      schemaOutline({
        properties: {
          status: {
            properties: { indicator: { enum: ["none", "minor"] } },
            required: ["indicator"],
            type: "object",
          },
        },
        required: ["status"],
        type: "object",
      })
    ).toBe('{\n  status: {\n    indicator: "none" | "minor";\n  };\n}');
  });

  test("writes a list as its item with brackets, a union of items in parentheses", () => {
    expect(schemaOutline({ items: { type: "string" }, type: "array" })).toBe(
      "string[]"
    );
    expect(schemaOutline({ items: { enum: ["a", "b"] }, type: "array" })).toBe(
      '("a" | "b")[]'
    );
    expect(
      schemaOutline({
        items: {
          properties: { id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        type: "array",
      })
    ).toBe("{\n  id: string;\n}[]");
  });

  test("reads a map by its keys, any of which may be missing", () => {
    expect(
      schemaOutline({
        additionalProperties: { type: "string" },
        propertyNames: { enum: ["ar", "en"], type: "string" },
        type: "object",
      })
    ).toBe('{ [key in "ar" | "en"]?: string }');
    expect(
      schemaOutline({
        additionalProperties: { type: "integer" },
        type: "object",
      })
    ).toBe("{ [key: string]: integer }");
  });

  test("opens a map whose value spans lines into a block", () => {
    expect(
      schemaOutline({
        additionalProperties: {
          properties: { x: { type: "string" } },
          required: ["x"],
          type: "object",
        },
        propertyNames: { enum: ["a", "b"], type: "string" },
        type: "object",
      })
    ).toBe('{\n  [key in "a" | "b"]?: {\n    x: string;\n  };\n}');
  });

  test("quotes a field name that is not an identifier", () => {
    expect(
      schemaOutline({
        properties: {
          id: { type: "string" },
          "webhook-id": { type: "string" },
        },
        required: ["id", "webhook-id"],
        type: "object",
      })
    ).toBe('{\n  id: string;\n  "webhook-id": string;\n}');
  });

  test("joins a union of objects as whole shapes", () => {
    expect(
      schemaOutline({
        anyOf: [
          {
            properties: { ok: { const: true, type: "boolean" } },
            required: ["ok"],
            type: "object",
          },
          {
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            type: "object",
          },
        ],
      })
    ).toBe("{\n  ok: true;\n} | {\n  ok: boolean;\n}");
  });

  test("writes a string's format after its field", () => {
    expect(
      schemaOutline({
        properties: {
          resolved_at: {
            anyOf: [{ format: "date-time", type: "string" }, { type: "null" }],
          },
          started_at: { format: "date-time", type: "string" },
        },
        required: ["resolved_at", "started_at"],
        type: "object",
      })
    ).toBe(
      "{\n  resolved_at: string | null; // date-time\n  started_at: string; // date-time\n}"
    );
  });

  test("writes a field's description above it", () => {
    expect(
      schemaOutline({
        properties: { title: { description: "The text.", type: "string" } },
        required: ["title"],
        type: "object",
      })
    ).toBe("{\n  // The text.\n  title: string;\n}");
  });

  test("writes a description the outline repeats once, at its first field", () => {
    const text = { description: "Per locale.", type: "string" };
    expect(
      schemaOutline({
        properties: {
          a: text,
          b: {
            properties: { c: text },
            required: ["c"],
            type: "object",
          },
        },
        required: ["a", "b"],
        type: "object",
      })
    ).toBe(
      "{\n  // Per locale.\n  a: string;\n  b: {\n    c: string;\n  };\n}"
    );
  });

  test("names an object with no fields, and a schema with no type, plainly", () => {
    expect(schemaOutline({ type: "object" })).toBe("object");
    expect(schemaOutline({})).toBe("unknown");
  });
});

describe("a description's text", () => {
  test("marks what the document wrote in backticks as a machine token", () => {
    expect(textSpans("A `HEAD` gets no body.")).toEqual([
      { code: false, text: "A " },
      { code: true, text: "HEAD" },
      { code: false, text: " gets no body." },
    ]);
  });

  test("with no backticks is one plain piece", () => {
    expect(textSpans("No such page.")).toEqual([
      { code: false, text: "No such page." },
    ]);
  });

  test("keeps an unclosed backtick as plain text", () => {
    expect(textSpans("a ` b")).toEqual([{ code: false, text: "a ` b" }]);
  });
});

describe("the reference's Markdown copy", () => {
  test("names an operation's methods, each of its paths and its summary", () => {
    const md = operationMarkdown(doc, "/badge.svg");
    expect(md).toContain("**GET HEAD** `/badge.svg`");
    expect(md).toContain("**GET HEAD** `/{locale}/status/{slug}/badge.svg`");
    expect(md).toContain("A status page's badge");
  });

  test("lists each parameter with where it goes, its type and its pattern", () => {
    expect(operationMarkdown(doc, "/api/heartbeat/{token}")).toContain(
      "- `token` (path): `string` matching `^[\\w-]{22}$`"
    );
    expect(operationMarkdown(doc, "/api/pages/{id}/{kind}")).toContain(
      "- `v` (query, optional): `string`. The image's SHA-256"
    );
  });

  test("gives each response its status, answer and one-line body", () => {
    expect(operationMarkdown(doc, "/api/heartbeat/{token}")).toContain(
      "- `404`: No heartbeat monitor has this token. Body: `text/plain` `Not Found`."
    );
    expect(operationMarkdown(doc, "/subscriptions/{token}/confirm")).toContain(
      "Headers: `location`."
    );
  });

  test("gives a body that spans lines as an outline in a code block", () => {
    const md = operationMarkdown(doc, "/health");
    expect(md).toContain(
      "`200` body, `application/json`:\n\n```ts\n{\n  // Always true in onboarding.\n  ok: true;"
    );
    expect(md).toContain("`503` body, `application/json`:");
  });

  test("of a path the document lacks fails, so the build does", () => {
    expect(() => operationMarkdown(doc, "/api/monitors")).toThrow();
  });

  test("lists every event of a webhook group with when it is sent, and their shared body once", () => {
    const md = webhookMarkdown(doc, "incident.updated");
    expect(md).toContain(
      "- `incident.published`: Sent to a subscriber's webhook when"
    );
    expect(md).toContain(
      "- `maintenance.cancelled`: Sent to a subscriber's webhook when"
    );
    expect(md.match(/```ts/g)).toHaveLength(1);
    expect(md).toContain("Headers:\n\n- `webhook-id` (header): `string`.");
  });

  test("gives a single webhook its method, name, summary and when it is sent", () => {
    const md = webhookMarkdown(doc, "monitor.down");
    expect(md).toContain(
      "**POST** `monitor.down`\n\nMonitor down\n\nSent when"
    );
    expect(md).toContain("- `webhook-signature` (header): `string`.");
  });

  test("outlines every body in full, a schema the document names by $ref as the schema it names", () => {
    for (const path of Object.keys(doc.paths)) {
      expect(operationMarkdown(doc, path), path).not.toMatch(bareUnknown);
      expect(operationMarkdown(doc, path), path).not.toContain("$ref");
    }
    for (const name of Object.keys(doc.webhooks)) {
      expect(webhookMarkdown(doc, name), name).not.toMatch(bareUnknown);
      expect(webhookMarkdown(doc, name), name).not.toContain("$ref");
    }
  });

  test("of a webhook the document lacks fails, so the build does", () => {
    expect(() => webhookMarkdown(doc, "monitor.deleted")).toThrow();
  });
});

describe("an Arabic page's Markdown copy of the reference", () => {
  test("names the reference's parts and where a parameter goes in Arabic, and keeps the document's own text", () => {
    const text = operationMarkdown(
      doc,
      "/api/pages/{id}/overview",
      apiLabels.ar
    );
    expect(text).toContain("المعلَمات:");
    expect(text).toContain("الاستجابات:");
    expect(text).not.toContain("Responses:");
    expect(text).toContain("A status page's overview document");
    expect(text).toContain("`id` (المسار)");
  });

  test("names a webhook group's body in Arabic", () => {
    const text = webhookMarkdown(doc, "monitor.down", apiLabels.ar);
    expect(text).toContain("المحتوى");
    expect(text).not.toContain("Body:");
  });
});
