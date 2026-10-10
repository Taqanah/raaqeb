/**
 * The API reference in a page's Markdown copy: each `<ApiOperation>`
 * and `<ApiWebhook>` tag, kept as a placeholder when the MDX compiles, is
 * written out from the OpenAPI document, as the page draws it.
 */
import type { PlaceholderData } from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import { openApiDocument } from "@/shared/api/openapi.ts";
import { labelsFor } from "./labels.ts";
import { operationMarkdown, webhookMarkdown } from "./reference.ts";

function attribute({ attributes, name }: PlaceholderData, key: string): string {
  const value = attributes[key];
  if (typeof value !== "string") {
    throw new Error(`<${name}> needs a ${key} written as a string`);
  }
  return value;
}

/** The placeholders' Markdown for a page in `locale`, its labels in that language. */
export function apiMarkdownFor(locale: string | undefined) {
  const labels = labelsFor(locale);
  return {
    ApiOperation: (data: PlaceholderData) =>
      operationMarkdown(openApiDocument(), attribute(data, "path"), labels),
    ApiWebhook: (data: PlaceholderData) =>
      webhookMarkdown(openApiDocument(), attribute(data, "name"), labels),
  };
}
