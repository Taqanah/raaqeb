import { describe, expect, test } from "bun:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import { z } from "zod";
import { localeSchema } from "@/shared/i18n/locale.ts";
import { healthReportSchema } from "@/shared/schemas/health.ts";
import { heartbeatTokenSchema } from "@/shared/schemas/heartbeat.ts";
import { notificationPayloadSchema } from "@/shared/schemas/notification.ts";
import { overviewDocumentSchema } from "@/shared/schemas/overview.ts";
import { pageImageKindSchema } from "@/shared/schemas/page.ts";
import {
  confirmationWebhookSchema,
  subscriberEventTypes,
  subscriberWebhookSchema,
} from "@/shared/schemas/subscription.ts";
import { summaryDocumentSchema } from "@/shared/schemas/summary.ts";
import {
  historyDocumentSchema,
  incidentDocumentSchema,
  maintenanceDocumentSchema,
  monthSchema,
} from "@/shared/schemas/views.ts";
import { inlineSchemas, openApiDocument } from "./openapi.ts";

const tsExtension = /\.ts$/;
const pathParameter = /^\$(.+)$/;
const byName = (a: string, b: string) => a.localeCompare(b);

/** Zod's JSON Schema of a shared schema, as the document embeds it: the dialect is the document's, so no `$schema` key. */
function schemaOf(schema: z.ZodType): unknown {
  const { $schema: _, ...rest } = z.toJSONSchema(schema);
  return rest;
}

interface Operation {
  parameters?: {
    description?: string;
    in: string;
    name: string;
    required: boolean;
    schema: unknown;
  }[];
  responses: Record<
    string,
    { content?: Record<string, { schema: unknown }>; description: string }
  >;
}

function operation(path: string, method: string): Operation {
  const item = inlineSchemas(openApiDocument()).paths[path] as
    | Record<string, Operation>
    | undefined;
  const found = item?.[method];
  if (!found) {
    throw new Error(`${method} ${path} is not in the document`);
  }
  return found;
}

const camelCase = /^[a-z][A-Za-z]*$/;
const componentRef = /"\$ref":"#\/components\/schemas\/([^"]+)"/g;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

// An operation as the document writes it, before any $ref is resolved.
const media = z.record(z.string(), z.object({ schema: z.unknown() }));
const rawItem = z.record(
  z.string(),
  z.object({
    requestBody: z.object({ content: media }).optional(),
    responses: z.record(z.string(), z.object({ content: media.optional() })),
  })
);

// The parts of the document a client generator and a viewer read beside the paths.
const described = z.object({
  info: z.object({ description: z.string() }),
  servers: z.array(z.object({ description: z.string(), url: z.string() })),
  tags: z.array(z.object({ description: z.string(), name: z.string() })),
});

const anyOperation = z.object({
  description: z.string().optional(),
  operationId: z.string().optional(),
  parameters: z
    .array(
      z.object({
        description: z.string().optional(),
        in: z.string(),
        name: z.string(),
      })
    )
    .optional(),
  summary: z.string(),
  tags: z.array(z.string()).optional(),
});
const pathItems = z.record(z.string(), z.record(z.string(), anyOperation));

/** Every operation in the document, each path's methods and each webhook's, named by where it is. */
function everyOperation(): {
  op: z.infer<typeof anyOperation>;
  where: string;
}[] {
  const document = openApiDocument();
  return [
    ...Object.entries(pathItems.parse(document.paths)).flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => ({
        op,
        where: `${method} ${path}`,
      }))
    ),
    ...Object.entries(pathItems.parse(document.webhooks)).flatMap(
      ([name, item]) =>
        Object.values(item).map((op) => ({
          op,
          where: `webhook ${name}`,
        }))
    ),
  ];
}

describe("the OpenAPI document", () => {
  test("is OpenAPI 3.1 about Raaqeb's public API and names no management endpoint", () => {
    const document = openApiDocument();
    expect(document.openapi).toBe("3.1.1");
    expect(document.info.title).toBe("Raaqeb public API");
    expect(Object.keys(document.paths).toSorted(byName)).toEqual(
      [
        "/api/custom-domain",
        "/api/heartbeat/{token}",
        "/api/openapi.json",
        "/api/pages/{id}/history",
        "/api/pages/{id}/history/{month}",
        "/api/pages/{id}/incidents/{incidentId}",
        "/api/pages/{id}/maintenance/{windowId}",
        "/api/pages/{id}/overview",
        "/api/pages/{id}/{kind}",
        "/api/v2/summary.json",
        "/badge.svg",
        "/feed.atom",
        "/health",
        "/status/{slug}/api/v2/summary.json",
        "/status/{slug}/badge.svg",
        "/status/{slug}/feed.atom",
        "/subscriptions/{token}/confirm",
        "/subscriptions/{token}/unsubscribe",
        "/{locale}/badge.svg",
        "/{locale}/feed.atom",
        "/{locale}/status/{slug}/badge.svg",
        "/{locale}/status/{slug}/feed.atom",
      ].toSorted(byName)
    );
  });

  test("heartbeat ingest takes GET, HEAD and POST with the token in the path, as the shared token schema describes it", () => {
    for (const method of ["get", "head", "post"]) {
      const ingest = operation("/api/heartbeat/{token}", method);
      expect(ingest.parameters).toEqual([
        {
          description: expect.any(String),
          in: "path",
          name: "token",
          required: true,
          schema: schemaOf(heartbeatTokenSchema),
        },
      ]);
      expect(Object.keys(ingest.responses).toSorted(byName)).toEqual([
        "200",
        "404",
        "503",
      ]);
    }
  });

  test("the custom domain question is a GET or HEAD with the domain in the query, answering 200, 404 or 503", () => {
    for (const method of ["get", "head"]) {
      const question = operation("/api/custom-domain", method);
      expect(question.parameters).toEqual([
        {
          description: expect.any(String),
          in: "query",
          name: "domain",
          required: true,
          schema: { type: "string" },
        },
      ]);
      expect(Object.keys(question.responses).toSorted(byName)).toEqual([
        "200",
        "404",
        "503",
      ]);
    }
  });

  test("a recorded heartbeat answers OK as plain text", () => {
    expect(operation("/api/heartbeat/{token}", "get").responses).toMatchObject({
      200: {
        content: {
          "text/plain": { schema: { const: "OK", type: "string" } },
        },
      },
    });
  });

  test("a status page's image is a GET or HEAD by the page's id and one of the three kinds, cached for a year when the URL carries its hash", () => {
    for (const method of ["get", "head"]) {
      const image = operation("/api/pages/{id}/{kind}", method);
      expect(image.parameters).toEqual([
        {
          description: expect.any(String),
          in: "path",
          name: "id",
          required: true,
          schema: { type: "string" },
        },
        {
          description: expect.any(String),
          in: "path",
          name: "kind",
          required: true,
          schema: schemaOf(pageImageKindSchema),
        },
        {
          description: expect.any(String),
          in: "query",
          name: "v",
          required: false,
          schema: { type: "string" },
        },
      ]);
      expect(Object.keys(image.responses).toSorted(byName)).toEqual([
        "200",
        "304",
        "404",
        "503",
      ]);
    }
  });

  test("a status page's overview document is a GET or HEAD by the page's id answering the shared schema, revalidated with its ETag", () => {
    for (const method of ["get", "head"]) {
      const overview = operation("/api/pages/{id}/overview", method);
      expect(overview.parameters).toEqual([
        {
          description: expect.any(String),
          in: "path",
          name: "id",
          required: true,
          schema: { type: "string" },
        },
      ]);
      expect(overview.responses["200"]).toMatchObject({
        content: {
          "application/json": { schema: schemaOf(overviewDocumentSchema) },
        },
      });
      expect(Object.keys(overview.responses).toSorted(byName)).toEqual([
        "200",
        "304",
        "404",
        "503",
      ]);
    }
  });

  test("each other view's document is a GET or HEAD by the page's id and the view's own, answering its shared schema, revalidated with its ETag", () => {
    const pageId = {
      description: expect.any(String),
      in: "path",
      name: "id",
      required: true,
      schema: { type: "string" },
    };
    const views = [
      ["/api/pages/{id}/history", historyDocumentSchema, [pageId]],
      [
        "/api/pages/{id}/history/{month}",
        historyDocumentSchema,
        [
          pageId,
          {
            description: expect.any(String),
            in: "path",
            name: "month",
            required: true,
            schema: schemaOf(monthSchema),
          },
        ],
      ],
      [
        "/api/pages/{id}/incidents/{incidentId}",
        incidentDocumentSchema,
        [
          pageId,
          {
            description: expect.any(String),
            in: "path",
            name: "incidentId",
            required: true,
            schema: { type: "string" },
          },
        ],
      ],
      [
        "/api/pages/{id}/maintenance/{windowId}",
        maintenanceDocumentSchema,
        [
          pageId,
          {
            description: expect.any(String),
            in: "path",
            name: "windowId",
            required: true,
            schema: { type: "string" },
          },
        ],
      ],
    ] as const;
    for (const [path, schema, parameters] of views) {
      for (const method of ["get", "head"]) {
        const view = operation(path, method);
        expect(view.parameters, path).toEqual([...parameters]);
        expect(view.responses["200"], path).toMatchObject({
          content: { "application/json": { schema: schemaOf(schema) } },
        });
        expect(Object.keys(view.responses).toSorted(byName), path).toEqual([
          "200",
          "304",
          "404",
          "503",
        ]);
      }
    }
  });

  test("validates against the OpenAPI 3.1 schema", async () => {
    const validator = new Validator();
    const result = await validator.validate(
      JSON.parse(JSON.stringify(openApiDocument()))
    );
    expect(result.errors).toBe(undefined);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe("3.1");
  });

  test("the validator refuses a document with no title", async () => {
    const document = JSON.parse(JSON.stringify(openApiDocument()));
    document.info.title = undefined;
    const result = await new Validator().validate(
      JSON.parse(JSON.stringify(document))
    );
    expect(result.valid).toBe(false);
  });

  test("the summary is a GET or HEAD at a page's plain address answering the shared schema, revalidated with its ETag", () => {
    const slug = {
      description: expect.any(String),
      in: "path",
      name: "slug",
      required: true,
      schema: { type: "string" },
    };
    for (const [path, parameters] of [
      ["/api/v2/summary.json", []],
      ["/status/{slug}/api/v2/summary.json", [slug]],
    ] as const) {
      for (const method of ["get", "head"]) {
        const summary = operation(path, method);
        expect(summary.parameters ?? [], path).toEqual([...parameters]);
        expect(summary.responses["200"], path).toMatchObject({
          content: {
            "application/json": { schema: schemaOf(summaryDocumentSchema) },
          },
        });
        expect(Object.keys(summary.responses).toSorted(byName), path).toEqual([
          "200",
          "304",
          "404",
          "503",
        ]);
      }
    }
  });

  test("the badge and the feed are a GET or HEAD at a page's plain address, the other locale under its prefix, revalidated with their ETag", () => {
    const slug = {
      description: expect.any(String),
      in: "path",
      name: "slug",
      required: true,
      schema: { type: "string" },
    };
    const locale = {
      description: expect.any(String),
      in: "path",
      name: "locale",
      required: true,
      schema: schemaOf(localeSchema),
    };
    for (const [file, type] of [
      ["badge.svg", "image/svg+xml"],
      ["feed.atom", "application/atom+xml"],
    ] as const) {
      for (const [path, parameters] of [
        [`/${file}`, []],
        [`/{locale}/${file}`, [locale]],
        [`/status/{slug}/${file}`, [slug]],
        [`/{locale}/status/{slug}/${file}`, [locale, slug]],
      ] as const) {
        for (const method of ["get", "head"]) {
          const resource = operation(path, method);
          expect(resource.parameters ?? [], path).toEqual([...parameters]);
          expect(resource.responses["200"], path).toEqual({
            content: { [type]: expect.anything() },
            description: expect.any(String),
          });
          expect(
            Object.keys(resource.responses).toSorted(byName),
            path
          ).toEqual(["200", "304", "404", "503"]);
        }
      }
    }
  });

  test("the document itself is served at /api/openapi.json", () => {
    const served = operation("/api/openapi.json", "get");
    expect(served.responses).toEqual({
      200: {
        content: {
          "application/json": {
            schema: { description: expect.any(String), type: "object" },
          },
        },
        description: expect.any(String),
      },
    });
  });

  test("every public server route is in the document, and every path in it is a route", async () => {
    const routes = new Set<string>();
    for await (const file of new Bun.Glob("**/*.ts").scan("src/routes")) {
      const parts = file.replace(tsExtension, "").split("/");
      // A leading dash keeps a file out of the route tree; Better Auth's endpoints and the admin's own downloads and upload are the admin's, not the public API.
      if (
        parts.some((part) => part.startsWith("-")) ||
        file === "api/auth/$.ts" ||
        parts[0] === "admin"
      ) {
        continue;
      }
      const segments = parts
        .filter((part) => part !== "index")
        .map((part) =>
          part.replaceAll("[.]", ".").replace(pathParameter, "{$1}")
        );
      const optional = segments[0] === "{-$locale}";
      const rest = `/${(optional ? segments.slice(1) : segments).join("/")}`;
      routes.add(rest);
      if (optional) {
        routes.add(`/{locale}${rest}`);
      }
    }
    // A view's HTML route is a .tsx file; only server routes are .ts.
    expect([...routes].toSorted(byName)).toEqual(
      Object.keys(openApiDocument().paths).toSorted(byName)
    );
  });

  test("a subscription's confirm and unsubscribe take a POST, the one-click unsubscribe of an email client among them, and answer 303 to the subscription's page; a GET goes there too", () => {
    for (const action of ["confirm", "unsubscribe"]) {
      const path = `/subscriptions/{token}/${action}`;
      expect(Object.keys(operation(path, "post").responses)).toContain("303");
      expect(Object.keys(operation(path, "get").responses)).toEqual(["303"]);
    }
  });

  test("an email client's one-click unsubscribe is documented: a plain 200 with no redirect", () => {
    expect(
      operation("/subscriptions/{token}/unsubscribe", "post").responses["200"]
    ).toBeDefined();
    expect(
      operation("/subscriptions/{token}/confirm", "post").responses["200"]
    ).toBeUndefined();
  });

  test("GET /health answers the shared health report on 200 and 503", () => {
    const health = operation("/health", "get");
    for (const status of ["200", "503"]) {
      expect(health.responses[status]).toMatchObject({
        content: {
          "application/json": { schema: schemaOf(healthReportSchema) },
        },
      });
    }
  });

  test("says what the API is, and that every path is relative to the install's public address", () => {
    const document = described.parse(openApiDocument());
    expect(document.info.description).toContain("no management API");
    expect(document.servers).toEqual([
      { description: expect.stringContaining("public address"), url: "/" },
    ]);
  });

  test("every operation, the webhooks' too, has a camelCase operationId unique in the document and one tag the document lists", () => {
    const document = described.parse(openApiDocument());
    const tags = document.tags.map((tag) => tag.name);
    const ids = everyOperation().map(({ op, where }) => {
      expect(op.operationId, where).toMatch(camelCase);
      expect(op.tags, where).toHaveLength(1);
      expect(tags, where).toContain(op.tags?.[0] ?? "");
      return op.operationId;
    });
    expect(new Set(ids).size).toBe(ids.length);
    for (const tag of document.tags) {
      expect(tag.description, tag.name).toEqual(expect.any(String));
    }
  });

  test("an operation's tag is its area: heartbeats, status pages, subscriptions, the webhooks Raaqeb sends, and the install's own under Meta", () => {
    const tagOf = Object.fromEntries(
      everyOperation().map(({ op, where }) => [where, op.tags?.[0]])
    );
    expect(tagOf).toMatchObject({
      "get /api/custom-domain": "Meta",
      "get /api/openapi.json": "Meta",
      "get /api/pages/{id}/overview": "Status pages",
      "get /api/pages/{id}/{kind}": "Status pages",
      "get /health": "Meta",
      "get /{locale}/feed.atom": "Status pages",
      "head /api/v2/summary.json": "Status pages",
      "post /api/heartbeat/{token}": "Heartbeats",
      "post /subscriptions/{token}/unsubscribe": "Subscriptions",
      "webhook channel.test": "Webhooks",
      "webhook incident.published": "Webhooks",
      "webhook subscription.confirmation": "Webhooks",
    });
  });

  test("an operationId is the method and the path's name, a webhook's is send and its name, so a generated client's names stay put", () => {
    const ids = Object.fromEntries(
      everyOperation().map(({ op, where }) => [where, op.operationId])
    );
    expect(ids).toMatchObject({
      "get /api/heartbeat/{token}": "getHeartbeat",
      "get /api/openapi.json": "getOpenApiDocument",
      "get /api/pages/{id}/overview": "getPageOverview",
      "get /health": "getHealth",
      "get /{locale}/status/{slug}/badge.svg": "getBadgeByLocaleAndSlug",
      "head /api/pages/{id}/overview": "headPageOverview",
      "post /api/heartbeat/{token}": "postHeartbeat",
      "post /subscriptions/{token}/confirm": "postSubscriptionConfirm",
      "webhook monitor.down": "sendMonitorDown",
      "webhook subscription.confirmation": "sendSubscriptionConfirmation",
    });
  });

  test("every path parameter says where its value comes from, in the same words wherever the name recurs", () => {
    const said = new Map<string, string>();
    for (const { op, where } of everyOperation()) {
      for (const parameter of op.parameters ?? []) {
        if (parameter.in !== "path") {
          continue;
        }
        expect(parameter.description, `${where} ${parameter.name}`).toEqual(
          expect.any(String)
        );
        const first = said.get(parameter.name) ?? parameter.description ?? "";
        expect(parameter.description, `${where} ${parameter.name}`).toBe(first);
        said.set(parameter.name, first);
      }
    }
    expect([...said.keys()].toSorted(byName)).toEqual(
      [
        "id",
        "incidentId",
        "kind",
        "locale",
        "month",
        "slug",
        "token",
        "windowId",
      ].toSorted(byName)
    );
  });

  test("a summary is a short title and the prose sits in the description", () => {
    for (const { op, where } of everyOperation()) {
      expect(op.summary.length, where).toBeLessThanOrEqual(40);
      expect(op.summary, where).not.toEndWith(".");
    }
  });

  test("each webhook says when it is sent", () => {
    for (const { op, where } of everyOperation()) {
      if (where.startsWith("webhook ")) {
        expect(op.description, where).toStartWith("Sent ");
      }
    }
  });

  test("every property of every schema in the document says what it means", () => {
    const undescribed = new Set<string>();
    const visit = (value: unknown, path: string): void => {
      if (typeof value !== "object" || value === null) {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "properties" && typeof child === "object" && child) {
          for (const [name, property] of Object.entries(child)) {
            const says =
              typeof property === "object" &&
              property !== null &&
              "description" in property &&
              typeof property.description === "string";
            if (!says) {
              undescribed.add(`${path}.${name}`);
            }
          }
        }
        visit(child, key === "properties" ? path : `${path}/${key}`);
      }
    };
    // A property named by $ref says what it means in the schema it names.
    visit(inlineSchemas(openApiDocument()), "");
    expect([...undescribed]).toEqual([]);
  });

  test("a body several operations answer or send is written once under components and named by $ref", () => {
    const document = openApiDocument();
    const overview = rawItem.parse(document.paths["/api/pages/{id}/overview"]);
    for (const method of ["get", "head"]) {
      expect(
        overview[method]?.responses["200"]?.content?.["application/json"]
          ?.schema,
        method
      ).toEqual(ref("OverviewDocument"));
    }
    for (const type of subscriberEventTypes) {
      expect(
        rawItem.parse(document.webhooks[type]).post?.requestBody?.content[
          "application/json"
        ]?.schema,
        type
      ).toEqual(ref("SubscriberWebhook"));
    }
    // The page's customization, which every view document carries.
    for (const name of [
      "OverviewDocument",
      "HistoryDocument",
      "IncidentDocument",
      "MaintenanceDocument",
    ]) {
      expect(document.components.schemas[name]?.properties, name).toMatchObject(
        { page: ref("StatusPage") }
      );
    }
  });

  test("every $ref names a schema under components, and resolving them leaves none", () => {
    const document = openApiDocument();
    const names = [...JSON.stringify(document).matchAll(componentRef)].map(
      ([, name]) => name ?? ""
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(Object.keys(document.components.schemas)).toContain(name);
    }
    expect(JSON.stringify(inlineSchemas(document))).not.toContain('"$ref"');
  });

  test("resolving a $ref keeps a keyword beside it over the named schema's", () => {
    const document = openApiDocument();
    const resolved = inlineSchemas({
      ...document,
      paths: { "/x": { ...ref("StatusPage"), description: "Mine." } },
    });
    expect(resolved.paths["/x"]).toMatchObject({
      description: "Mine.",
      type: "object",
    });
  });

  test("resolving a $ref to no schema throws", () => {
    const document = openApiDocument();
    expect(() =>
      inlineSchemas({
        ...document,
        paths: { "/x": { get: { schema: ref("Missing") } } },
      })
    ).toThrow();
  });

  test("the document is plain JSON: it survives a round trip unchanged", () => {
    const document = openApiDocument();
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });
});

interface WebhookOperation {
  parameters: { in: string; name: string; required: boolean }[];
  requestBody: {
    content: Record<string, { schema: unknown }>;
    required: boolean;
  };
  responses: Record<string, { description: string }>;
}

describe("the webhook's documented schema", () => {
  const webhooks = inlineSchemas(openApiDocument()).webhooks as Record<
    string,
    { post?: WebhookOperation }
  >;

  test("every notification type is a webhook whose body is its shared schema", () => {
    const types = notificationPayloadSchema.options.map(
      (option) => option.shape.type.value
    );
    // A subscriber's webhook gets its own bodies, listed beside the operator's.
    expect(Object.keys(webhooks).toSorted(byName)).toEqual(
      [...types, "subscription.confirmation", ...subscriberEventTypes].toSorted(
        byName
      )
    );
    for (const option of notificationPayloadSchema.options) {
      const post = webhooks[option.shape.type.value]?.post;
      expect(post?.requestBody.required).toBe(true);
      expect(post?.requestBody.content["application/json"]?.schema).toEqual(
        schemaOf(option)
      );
      expect(Object.keys(post?.responses ?? {})).toEqual(["2XX"]);
    }
  });

  test("a notification's monitor may be a database monitor, refused at sign-in or at its query or wanting TLS", () => {
    const text = JSON.stringify(webhooks);
    for (const name of [
      "postgres",
      "mysql",
      "redis",
      "auth_failed",
      "query_failed",
      "tls_required",
    ]) {
      expect(text).toContain(`"${name}"`);
    }
  });

  test("a notification's monitor may be a Docker monitor, down for each reason a container gives", () => {
    const text = JSON.stringify(webhooks);
    for (const name of [
      "docker",
      "container_not_found",
      "container_not_running",
      "container_restarting",
      "container_paused",
      "container_dead",
      "container_unhealthy",
    ]) {
      expect(text).toContain(`"${name}"`);
    }
  });

  test("every operator webhook names the three Standard Webhooks headers, all required", () => {
    for (const option of notificationPayloadSchema.options) {
      const post = webhooks[option.shape.type.value]?.post;
      expect(
        post?.parameters.map((parameter) => [
          parameter.in,
          parameter.name,
          parameter.required,
        ])
      ).toEqual([
        ["header", "webhook-id", true],
        ["header", "webhook-timestamp", true],
        ["header", "webhook-signature", true],
      ]);
    }
  });

  test("a subscriber's webhook gets Statuspage's body for each event and Raaqeb's own for its confirmation, with webhook-id and webhook-timestamp and no signature", () => {
    const bodies = {
      "subscription.confirmation": schemaOf(confirmationWebhookSchema),
      ...Object.fromEntries(
        subscriberEventTypes.map((type) => [
          type,
          schemaOf(subscriberWebhookSchema),
        ])
      ),
    };
    for (const [type, schema] of Object.entries(bodies)) {
      const post = webhooks[type]?.post;
      expect(post?.requestBody.content["application/json"]?.schema).toEqual(
        schema
      );
    }
    for (const type of ["subscription.confirmation", ...subscriberEventTypes]) {
      expect(
        webhooks[type]?.post?.parameters.map((parameter) => [
          parameter.in,
          parameter.name,
          parameter.required,
        ])
      ).toEqual([
        ["header", "webhook-id", true],
        ["header", "webhook-timestamp", true],
      ]);
    }
  });
});
