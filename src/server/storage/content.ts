/**
 * Content in a column (CONTEXT.md "Content"): one text per locale as
 * JSON text, in the column the single text held before. The repositories
 * that keep content write and read it through these two.
 */
import { type Content, contentShapeSchema } from "@/shared/schemas/content.ts";

/** The column's text for the content. */
export function contentText(content: Content): string {
  return JSON.stringify(content);
}

/** The content a column holds, or nothing when its text is not content: the caller reports the row. */
export function storedContent(text: string): Content | undefined {
  const parsed = contentShapeSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
