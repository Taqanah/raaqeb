import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openApiDocument } from "@/shared/api/openapi.ts";

const tsExtension = /\.ts$/;
const pathParameter = /^\$(.+)$/;
const templateParameter = /\{([^}]+)\}/g;
// The words a response uses for the request that finds no database open.
const noDatabase = /no database|not open/i;

/** A value for each path parameter the document names, of the shape its route accepts. */
const values: Readonly<Record<string, string>> = {
  id: "page",
  incidentId: "incident",
  kind: "logo",
  locale: "en",
  month: "2026-09",
  slug: "status",
  token: "token",
  windowId: "window",
};

type Handler = (input: {
  context: object;
  params: Record<string, string>;
  request: Request;
}) => Promise<Response> | Response;

// A route module is the test's parse boundary: Start keeps its handlers on the route's options.
const routeModule = z.object({
  Route: z.object({
    options: z.object({
      server: z.object({
        handlers: z.record(
          z.string(),
          z.custom<Handler>((value) => typeof value === "function")
        ),
      }),
    }),
  }),
});

const responseSchema = z.object({
  content: z
    .object({
      "text/plain": z.object({ schema: z.object({ const: z.string() }) }),
    })
    .partial()
    .optional(),
  description: z.string(),
});
const operationSchema = z.object({
  responses: z.record(z.string(), responseSchema),
});

/** Each public route file by the document's path, mapped as the document's own test maps them. */
async function routeFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const file of new Bun.Glob("**/*.ts").scan("src/routes")) {
    const parts = file.replace(tsExtension, "").split("/");
    if (parts.some((part) => part.startsWith("-")) || parts[0] === "admin") {
      continue;
    }
    const segments = parts
      .filter((part) => part !== "index")
      .map((part) =>
        part.replaceAll("[.]", ".").replace(pathParameter, "{$1}")
      );
    const optional = segments[0] === "{-$locale}";
    const rest = `/${(optional ? segments.slice(1) : segments).join("/")}`;
    files.set(rest, file);
    if (optional) {
      files.set(`/{locale}${rest}`, file);
    }
  }
  return files;
}

/** One request the document describes, as its route answers it with no database open. */
async function answer(
  path: string,
  verb: string,
  file: string
): Promise<Response> {
  const { handlers } = routeModule.parse(await import(`./${file}`)).Route
    .options.server;
  const handler = handlers[verb];
  if (handler === undefined) {
    throw new Error(`${verb} ${path} has no handler`);
  }
  const value = (name: string) => values[name] ?? name;
  const url = new URL(
    path.replaceAll(templateParameter, (_, name: string) => value(name)),
    "http://raaqeb.test"
  );
  url.searchParams.set("domain", "status.example.com");
  // What the Bun.serve entry hands a route before a database is open: no storage, no scheduler, no page resolved.
  return await handler({
    context: {
      publicTarget: undefined,
      scheduler: undefined,
      storage: undefined,
    },
    params: Object.fromEntries(
      [...path.matchAll(templateParameter)].map(([, name = ""]) => [
        name,
        value(name),
      ])
    ),
    request: new Request(url, { method: verb }),
  });
}

describe("the OpenAPI document with no database open", () => {
  test("every operation declares the status and body its route answers with no database, and says no database only on that answer", async () => {
    const files = await routeFiles();
    const operations = Object.entries(openApiDocument().paths).flatMap(
      ([path, item]) =>
        Object.entries(z.record(z.string(), operationSchema).parse(item)).map(
          ([method, operation]) => ({ method, operation, path })
        )
    );
    await Promise.all(
      operations.map(async ({ method, operation, path }) => {
        const file = files.get(path);
        if (file === undefined) {
          throw new Error(`${path} has no route file`);
        }
        const verb = method.toUpperCase();
        const response = await answer(path, verb, file);
        const where = `${verb} ${path} answered ${response.status}`;
        const declared = operation.responses[String(response.status)];
        expect(declared, where).toBeDefined();
        const text = declared?.content?.["text/plain"]?.schema.const;
        if (text !== undefined && verb !== "HEAD") {
          expect(await response.text(), where).toBe(text);
        }
        if (response.status >= 400) {
          expect(declared?.description, where).toMatch(noDatabase);
        }
        for (const [status, other] of Object.entries(operation.responses)) {
          if (status !== String(response.status)) {
            expect(other.description, `${where}, not ${status}`).not.toMatch(
              noDatabase
            );
          }
        }
      })
    );
  });
});
