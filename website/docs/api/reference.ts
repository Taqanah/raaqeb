/**
 * The API reference, read from the OpenAPI document Raaqeb serves at
 * /api/openapi.json, so the pages never drift from it. Methods and paths
 * that answer alike are one entry: a heartbeat's GET, HEAD and POST, a
 * badge at its four addresses, the seven subscriber events sharing one body.
 */
import { z } from "zod";
import { inlineSchemas, type OpenApiDocument } from "@/shared/api/openapi.ts";
import { type ApiLabels, apiLabels } from "./labels.ts";

/** A JSON Schema as the document embeds it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ApiParameter {
  readonly description?: string;
  readonly location: string;
  readonly name: string;
  readonly required: boolean;
  readonly schema: JsonSchema;
}

export interface ApiBody {
  readonly mediaType: string;
  readonly schema?: JsonSchema;
}

export interface ApiResponse {
  readonly bodies: readonly ApiBody[];
  readonly description: string;
  readonly headers: readonly string[];
  readonly status: string;
}

/** One or more methods at one or more paths that answer alike. */
export interface ApiOperation {
  readonly description?: string;
  readonly methods: readonly string[];
  readonly parameters: readonly ApiParameter[];
  readonly paths: readonly string[];
  readonly requestBodies: readonly ApiBody[];
  readonly responses: readonly ApiResponse[];
  readonly summary: string;
}

/** One or more webhooks that send the same headers and body, each with its own summary and when it is sent. */
export interface ApiWebhookGroup {
  readonly method: string;
  readonly parameters: readonly ApiParameter[];
  readonly requestBodies: readonly ApiBody[];
  readonly responses: readonly ApiResponse[];
  readonly webhooks: readonly {
    readonly description?: string;
    readonly name: string;
    readonly summary: string;
  }[];
}

/** A piece of a description: plain text, or a machine token the document wrote in backticks. */
export interface TextSpan {
  readonly code: boolean;
  readonly text: string;
}

// The parse boundary: the document is plain JSON, read into the few shapes the pages show.
const json = z.record(z.string(), z.unknown());
const content = z
  .record(z.string(), z.object({ schema: json.optional() }))
  .default({});
const operationSchema = z.object({
  description: z.string().optional(),
  parameters: z
    .array(
      z.object({
        description: z.string().optional(),
        in: z.string(),
        name: z.string(),
        required: z.boolean().default(false),
        schema: json,
      })
    )
    .default([]),
  requestBody: z.object({ content }).optional(),
  responses: z.record(
    z.string(),
    z.object({ content, description: z.string(), headers: json.default({}) })
  ),
  summary: z.string(),
});
type ParsedOperation = z.infer<typeof operationSchema>;

function parameterOf(p: ParsedOperation["parameters"][number]): ApiParameter {
  return {
    location: p.in,
    name: p.name,
    required: p.required,
    schema: p.schema,
    ...(p.description ? { description: p.description } : {}),
  };
}

function bodiesOf(media: z.infer<typeof content>): ApiBody[] {
  return Object.entries(media).map(([mediaType, { schema }]) =>
    schema ? { mediaType, schema } : { mediaType }
  );
}

function responsesOf(op: ParsedOperation): ApiResponse[] {
  return Object.entries(op.responses).map(([status, r]) => ({
    bodies: bodiesOf(r.content),
    description: r.description,
    headers: Object.keys(r.headers),
    status,
  }));
}

/** The methods of one path item, those with the same operation together; each method has its own operationId, which the pages do not show. */
function methodsAlike(
  item: unknown
): { methods: string[]; operation: Record<string, unknown> }[] {
  const alike = new Map<
    string,
    { methods: string[]; operation: Record<string, unknown> }
  >();
  for (const [method, operation] of Object.entries(json.parse(item))) {
    const { operationId: _, ...parsed } = json.parse(operation);
    const key = JSON.stringify(parsed);
    const seen = alike.get(key);
    if (seen) {
      seen.methods.push(method);
    } else {
      alike.set(key, { methods: [method], operation: parsed });
    }
  }
  return [...alike.values()];
}

/** Every operation in the document, methods and paths that answer alike as one, each schema the document names by `$ref` written out. */
function allOperations(named: OpenApiDocument): ApiOperation[] {
  const doc = inlineSchemas(named);
  const operations = new Map<
    string,
    ApiOperation & { parameters: ApiParameter[]; paths: string[] }
  >();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const { methods, operation } of methodsAlike(item)) {
      const op = operationSchema.parse(operation);
      // Paths answer alike when all but their parameters is the same.
      const { parameters: _, ...answer } = operation;
      const key = JSON.stringify([methods, answer]);
      const seen = operations.get(key);
      if (!seen) {
        operations.set(key, {
          methods,
          parameters: op.parameters.map(parameterOf),
          paths: [path],
          requestBodies: bodiesOf(op.requestBody?.content ?? {}),
          responses: responsesOf(op),
          summary: op.summary,
          ...(op.description ? { description: op.description } : {}),
        });
        continue;
      }
      seen.paths.push(path);
      for (const p of op.parameters) {
        if (
          !seen.parameters.some((q) => q.name === p.name && q.location === p.in)
        ) {
          seen.parameters.push(parameterOf(p));
        }
      }
    }
  }
  return [...operations.values()];
}

/** Every operation that answers at `path`, each with the other paths that answer alike. */
export function operationsAt(
  doc: OpenApiDocument,
  path: string
): ApiOperation[] {
  return allOperations(doc).filter((o) => o.paths.includes(path));
}

/** The webhook named `name` with the others that send the same body; undefined when the document has no such webhook. */
export function webhookGroupOf(
  named: OpenApiDocument,
  name: string
): ApiWebhookGroup | undefined {
  const doc = inlineSchemas(named);
  const groups = new Map<
    string,
    ApiWebhookGroup & { webhooks: ApiWebhookGroup["webhooks"][number][] }
  >();
  for (const [webhook, item] of Object.entries(doc.webhooks)) {
    for (const { methods, operation } of methodsAlike(item)) {
      const op = operationSchema.parse(operation);
      // Webhooks are one entry when all but their summary and description is the same.
      const { description: _, summary: __, ...body } = operation;
      const entry = {
        name: webhook,
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
      };
      for (const method of methods) {
        const key = JSON.stringify([method, body]);
        const seen = groups.get(key);
        if (seen) {
          seen.webhooks.push(entry);
        } else {
          groups.set(key, {
            method,
            parameters: op.parameters.map(parameterOf),
            requestBodies: bodiesOf(op.requestBody?.content ?? {}),
            responses: responsesOf(op),
            webhooks: [entry],
          });
        }
      }
    }
  }
  return [...groups.values()].find((g) =>
    g.webhooks.some((w) => w.name === name)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the outline of `schema` is a union, which a list must wrap in parentheses. */
function isUnion(schema: unknown): boolean {
  if (!isRecord(schema) || "const" in schema) {
    return false;
  }
  const options = schema.anyOf ?? schema.oneOf ?? schema.enum ?? schema.type;
  return Array.isArray(options) && options.length > 1;
}

/** A string's format, also inside a nullable union, which the outline writes as a comment. */
function formatOf(schema: unknown): string | undefined {
  if (!isRecord(schema)) {
    return;
  }
  if (typeof schema.format === "string") {
    return schema.format;
  }
  const options = schema.anyOf ?? schema.oneOf;
  return Array.isArray(options)
    ? options.map(formatOf).find((f) => f !== undefined)
    : undefined;
}

/** A field name that needs no quotes. */
const identifier = /^[A-Za-z_$][\w$]*$/;

/** The descriptions an outline has written, so a repeated one is written once. */
type Written = Set<string>;

function objectOutline(
  schema: Record<string, unknown>,
  pad: string,
  written: Written
): string {
  const inner = `${pad}  `;
  const properties = isRecord(schema.properties)
    ? Object.entries(schema.properties)
    : [];
  if (properties.length === 0) {
    if (!isRecord(schema.additionalProperties)) {
      return "object";
    }
    const keys =
      isRecord(schema.propertyNames) && Array.isArray(schema.propertyNames.enum)
        ? `[key in ${schema.propertyNames.enum.map((k) => JSON.stringify(k)).join(" | ")}]?`
        : "[key: string]";
    const value = outline(schema.additionalProperties, inner, written);
    return value.includes("\n")
      ? `{\n${inner}${keys}: ${value};\n${pad}}`
      : `{ ${keys}: ${value} }`;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const lines = properties.map(([name, property]) => {
    const text =
      isRecord(property) && typeof property.description === "string"
        ? property.description
        : undefined;
    const description =
      text && !written.has(text) ? `${inner}// ${text}\n` : "";
    if (text) {
      written.add(text);
    }
    const key = identifier.test(name) ? name : JSON.stringify(name);
    const optional = required.includes(name) ? "" : "?";
    const format = formatOf(property);
    return `${description}${inner}${key}${optional}: ${outline(property, inner, written)};${format ? ` // ${format}` : ""}`;
  });
  return `{\n${lines.join("\n")}\n${pad}}`;
}

function outline(schema: unknown, pad: string, written: Written): string {
  if (!isRecord(schema)) {
    return "unknown";
  }
  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  const options = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(options)) {
    return options.map((o) => outline(o, pad, written)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((type) => outline({ ...schema, type }, pad, written))
      .join(" | ");
  }
  if (schema.type === "array") {
    const item = outline(schema.items, pad, written);
    return isUnion(schema.items) ? `(${item})[]` : `${item}[]`;
  }
  if (schema.type === "object") {
    return objectOutline(schema, pad, written);
  }
  return typeof schema.type === "string" ? schema.type : "unknown";
}

/** A schema as a TypeScript-like outline: unions, optional fields and literal values read at a glance. */
export function schemaOutline(schema: JsonSchema): string {
  return outline(schema, "", new Set());
}

/** A description cut at its backticks. */
export function textSpans(text: string): TextSpan[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) {
    return [{ code: false, text }];
  }
  return parts
    .map((part, i) => ({ code: i % 2 === 1, text: part }))
    .filter((span) => span.text !== "");
}

/** A body's outline; a plain-text body that is one fixed text reads as that text, without a JSON string's quotes. */
export function bodyOutline({
  mediaType,
  schema,
}: ApiBody): string | undefined {
  if (mediaType === "text/plain" && typeof schema?.const === "string") {
    return schema.const;
  }
  return schema && schemaOutline(schema);
}

function parametersMarkdown(
  parameters: readonly ApiParameter[],
  labels: ApiLabels
): string[] {
  if (parameters.length === 0) {
    return [];
  }
  const label = parameters.every((p) => p.location === "header")
    ? `${labels.headers}:`
    : `${labels.parameters}:`;
  const items = parameters.map((p) => {
    const location = labels.locations[p.location] ?? p.location;
    const where = p.required
      ? location
      : `${location}${labels.comma}${labels.optional}`;
    const pattern =
      typeof p.schema.pattern === "string"
        ? ` ${labels.matching} \`${p.schema.pattern}\``
        : "";
    const description = p.description ? ` ${p.description}` : "";
    return `- \`${p.name}\` (${where}): \`${schemaOutline(p.schema)}\`${pattern}.${description}`;
  });
  return [label, items.join("\n")];
}

/** The bodies that fit one line, as running text. */
function shortBodies(bodies: readonly ApiBody[], labels: ApiLabels): string {
  return bodies
    .filter((b) => !bodyOutline(b)?.includes("\n"))
    .map((b) => {
      const text = bodyOutline(b);
      return text ? `\`${b.mediaType}\` \`${text}\`` : `\`${b.mediaType}\``;
    })
    .join(labels.comma);
}

/** The bodies that span lines, each as an outline in a code block under `label`. */
function longBodies(bodies: readonly ApiBody[], label: string): string[] {
  return bodies.flatMap((b) => {
    const text = bodyOutline(b);
    return text?.includes("\n")
      ? [`${label}, \`${b.mediaType}\`:`, `\`\`\`ts\n${text}\n\`\`\``]
      : [];
  });
}

function bodiesMarkdown(
  bodies: readonly ApiBody[],
  label: string,
  labels: ApiLabels
): string[] {
  const short = shortBodies(bodies, labels);
  return [
    ...(short ? [`${label}: ${short}.`] : []),
    ...longBodies(bodies, label),
  ];
}

function responsesMarkdown(
  responses: readonly ApiResponse[],
  labels: ApiLabels
): string[] {
  const items = responses.map((r) => {
    const headers =
      r.headers.length > 0
        ? ` ${labels.headers}: ${r.headers.map((h) => `\`${h}\``).join(labels.comma)}.`
        : "";
    const short = shortBodies(r.bodies, labels);
    return `- \`${r.status}\`: ${r.description}${headers}${short ? ` ${labels.body}: ${short}.` : ""}`;
  });
  return [
    `${labels.responses}:`,
    items.join("\n"),
    ...responses.flatMap((r) =>
      longBodies(r.bodies, labels.statusBody(r.status))
    ),
  ];
}

function endpointMarkdown(methods: readonly string[], target: string): string {
  return `**${methods.map((m) => m.toUpperCase()).join(" ")}** \`${target}\``;
}

/** Every operation at `path` as Markdown, for the page's Markdown copy; a path the document lacks throws. */
export function operationMarkdown(
  doc: OpenApiDocument,
  path: string,
  labels: ApiLabels = apiLabels.en
): string {
  const operations = operationsAt(doc, path);
  if (operations.length === 0) {
    throw new Error(`the OpenAPI document has no path ${path}`);
  }
  return operations
    .map((op) =>
      [
        ...op.paths.map((p) => endpointMarkdown(op.methods, p)),
        op.summary,
        ...(op.description ? [op.description] : []),
        ...parametersMarkdown(op.parameters, labels),
        ...bodiesMarkdown(op.requestBodies, labels.requestBody, labels),
        ...responsesMarkdown(op.responses, labels),
      ].join("\n\n")
    )
    .join("\n\n");
}

/** The webhook `name` and the others sending the same body, as Markdown; a name the document lacks throws. */
export function webhookMarkdown(
  doc: OpenApiDocument,
  name: string,
  labels: ApiLabels = apiLabels.en
): string {
  const group = webhookGroupOf(doc, name);
  if (!group) {
    throw new Error(`the OpenAPI document has no webhook ${name}`);
  }
  const [only] = group.webhooks;
  return [
    ...group.webhooks.map((w) => endpointMarkdown([group.method], w.name)),
    ...(only && group.webhooks.length === 1
      ? [only.summary, ...(only.description ? [only.description] : [])]
      : [
          group.webhooks
            .map((w) => `- \`${w.name}\`: ${w.description ?? w.summary}`)
            .join("\n"),
        ]),
    ...parametersMarkdown(group.parameters, labels),
    ...bodiesMarkdown(group.requestBodies, labels.body, labels),
    ...responsesMarkdown(group.responses, labels),
  ].join("\n\n");
}
