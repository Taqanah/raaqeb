/**
 * A status page's logo, favicon and cover image: uploaded into the database, so an install without a volume keeps
 * them, and served at `/api/pages/<page id>/<kind>?v=<hash>`. A file is
 * taken for what its first bytes say, never for the name or type the
 * browser sent: PNG, JPEG, WebP or SVG, and ICO for a favicon. Every image
 * is served with a sandbox Content-Security-Policy, so an SVG opened on its
 * own runs nothing. A URL carrying the image's hash is cached for a year.
 */

import type { StoredImage } from "@/server/storage/pages.ts";
import type { Storage } from "@/server/storage/storage.ts";
import {
  type PageImageKind,
  type PageImageResult,
  pageImageKindSchema,
  pageImageMaxBytes,
} from "@/shared/schemas/page.ts";

export type ImageStorage = Pick<Storage, "bump" | "pages">;

const unavailable = { ok: false, reason: "unavailable" } as const;
const notFound = { ok: false, reason: "not_found" } as const;

const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpeg = [0xff, 0xd8, 0xff];
const riff = [0x52, 0x49, 0x46, 0x46];
const webp = [0x57, 0x45, 0x42, 0x50];
const ico = [0x00, 0x00, 0x01, 0x00];

/** The media type of a file by its first bytes; nothing for a type this kind of image does not take. */
export function imageTypeOf(
  bytes: Uint8Array,
  kind: PageImageKind
): string | undefined {
  const startsWith = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith(png)) {
    return "image/png";
  }
  if (startsWith(jpeg)) {
    return "image/jpeg";
  }
  if (startsWith(riff) && startsWith(webp, 8)) {
    return "image/webp";
  }
  if (kind === "favicon" && startsWith(ico)) {
    return "image/x-icon";
  }
  return isSvg(bytes) ? "image/svg+xml" : undefined;
}

const svgElement = /^<svg[\s/>]/;
const weakTag = /^W\//;

/** What may come before an SVG's first element, each from its opening to its end. */
const preludes: readonly (readonly [string, string])[] = [
  ["<?xml", "?>"],
  ["<!--", "-->"],
  ["<!doctype", ">"],
];

/** An SVG document: after white space, an XML declaration, comments and a doctype (with its entity subset), its first element is `svg`. The decoder drops a byte order mark; the whole file is read, since a licence comment can be long and the cap bounds it. */
function isSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder().decode(bytes);
  for (;;) {
    text = text.trimStart();
    const lower = text.toLowerCase();
    const prelude = preludes.find(([open]) => lower.startsWith(open));
    if (!prelude) {
      return svgElement.test(text);
    }
    const [, close] = prelude;
    // A doctype's internal subset, between brackets, holds ">" of its own.
    const subset = text.indexOf("[");
    const from =
      close === ">" && subset >= 0 && subset < text.indexOf(">")
        ? text.indexOf("]", subset)
        : 0;
    const end = from < 0 ? -1 : text.indexOf(close, from);
    if (end < 0) {
      return false;
    }
    text = text.slice(end + close.length);
  }
}

/** Stores or replaces the page's image of this kind. */
export async function uploadPageImage(
  storage: ImageStorage,
  pageId: string,
  kind: PageImageKind,
  file: Blob
): Promise<PageImageResult> {
  // The size is checked before a byte is read.
  if (file.size > pageImageMaxBytes[kind]) {
    return { ok: false, reason: "too_large" };
  }
  try {
    const body = new Uint8Array(await file.arrayBuffer());
    const contentType = imageTypeOf(body, kind);
    if (contentType === undefined) {
      return { ok: false, reason: "invalid" };
    }
    const image = {
      contentType,
      hash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      kind,
    };
    if (!(await storage.pages.setImage(pageId, { ...image, body }))) {
      return notFound;
    }
    await storage.bump();
    return { image, ok: true };
  } catch {
    return unavailable;
  }
}

/** Deletes the page's image of this kind; a kind with no image is already gone. */
export async function removePageImage(
  storage: ImageStorage,
  pageId: string,
  kind: PageImageKind
): Promise<PageImageResult> {
  try {
    if (!(await storage.pages.find(pageId))) {
      return notFound;
    }
    if (await storage.pages.removeImage(pageId, kind)) {
      await storage.bump();
    }
    return { image: undefined, ok: true };
  } catch {
    return unavailable;
  }
}

/** Nothing to run, nothing to fetch: an SVG opened on its own draws and nothing more. */
export const imagePolicy =
  "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function plain(status: 404 | 503, text: string): Response {
  return new Response(text, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
    status,
  });
}

/**
 * The public answer for one image: 200 with its bytes, cached for a year
 * when `v` is its hash and revalidated otherwise; 304 when the browser
 * holds it; 404 for no such image; 503 with no database. HEAD answers the
 * headers alone. An unpublished page's image is the signed-in operator's
 * alone, never stored by anyone, and not found to anyone else;
 * `operator` tells whether the request carries the session.
 */
export async function pageImageResponse(
  storage: Pick<Storage, "pages"> | undefined,
  pageId: string,
  kind: string,
  request: Request,
  operator: () => Promise<boolean>
): Promise<Response> {
  if (!storage) {
    return plain(503, "Service Unavailable");
  }
  const known = pageImageKindSchema.safeParse(kind);
  if (!known.success) {
    return plain(404, "Not Found");
  }
  let image: StoredImage | undefined;
  let published = false;
  try {
    const [stored, page] = await Promise.all([
      storage.pages.image(pageId, known.data),
      storage.pages.find(pageId),
    ]);
    image = stored;
    published = page?.published ?? false;
  } catch {
    return plain(503, "Service Unavailable");
  }
  if (!(image && (published || (await operator())))) {
    return plain(404, "Not Found");
  }
  const etag = `"${image.hash}"`;
  const current = new URL(request.url).searchParams.get("v") === image.hash;
  let cacheControl = "public, max-age=0, must-revalidate";
  if (!published) {
    cacheControl = "no-store";
  } else if (current) {
    cacheControl = "public, max-age=31536000, immutable";
  }
  const headers = {
    "cache-control": cacheControl,
    "content-security-policy": imagePolicy,
    "content-type": image.contentType,
    etag,
    "x-content-type-options": "nosniff",
  };
  const held = (request.headers.get("if-none-match") ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(weakTag, ""));
  if (held.includes(etag)) {
    return new Response(null, { headers, status: 304 });
  }
  return new Response(request.method === "HEAD" ? null : image.body, {
    headers,
  });
}
