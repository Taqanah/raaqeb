import { afterEach, describe, expect, test } from "bun:test";
import { pageImageMaxBytes } from "@/shared/schemas/page.ts";
import { type PagesScratch, publish, scratchPages } from "./fixture.ts";
import {
  imageTypeOf,
  pageImageResponse,
  removePageImage,
  uploadPageImage,
} from "./images.ts";
import { createPage } from "./pages.ts";

let scratch: PagesScratch | undefined;

afterEach(async () => {
  await scratch?.cleanup();
  scratch = undefined;
});

const pngBytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
const jpegBytes = [255, 216, 255, 224, 0, 16, 74, 70];
const webpBytes = [
  ...new TextEncoder().encode("RIFF"),
  36,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
];
const icoBytes = [0, 0, 1, 0, 1, 0, 16, 16];
const gifBytes = [...new TextEncoder().encode("GIF89a"), 1, 0];
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"/>';

const bytes = (values: readonly number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("what a file is, by its first bytes", () => {
  test("PNG, JPEG, WebP and SVG are taken for every kind", () => {
    for (const kind of ["logo", "favicon", "cover"] as const) {
      expect(imageTypeOf(bytes(pngBytes), kind)).toBe("image/png");
      expect(imageTypeOf(bytes(jpegBytes), kind)).toBe("image/jpeg");
      expect(imageTypeOf(bytes(webpBytes), kind)).toBe("image/webp");
      expect(imageTypeOf(text(svgText), kind)).toBe("image/svg+xml");
    }
  });

  test("an ICO is taken for a favicon only", () => {
    expect(imageTypeOf(bytes(icoBytes), "favicon")).toBe("image/x-icon");
    expect(imageTypeOf(bytes(icoBytes), "logo")).toBeUndefined();
    expect(imageTypeOf(bytes(icoBytes), "cover")).toBeUndefined();
  });

  test("an SVG may start with a byte order mark, white space, an XML declaration or a comment", () => {
    for (const value of [
      `﻿${svgText}`,
      `\n  ${svgText}`,
      `<?xml version="1.0" encoding="UTF-8"?>\n${svgText}`,
      `<!-- logo -->\n<!DOCTYPE svg>\n${svgText}`,
    ]) {
      expect(imageTypeOf(text(value), "logo")).toBe("image/svg+xml");
    }
  });

  test("an SVG with an entity subset in its doctype, or a long licence comment before it, is an SVG", () => {
    const withEntities = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n  <!ENTITY ns_svg "http://www.w3.org/2000/svg">\n  <!ENTITY ns_xlink "http://www.w3.org/1999/xlink">\n]>\n${svgText}`;
    const licensed = `<!-- ${"licence text ".repeat(200)} -->\n${svgText}`;
    expect(imageTypeOf(text(withEntities), "logo")).toBe("image/svg+xml");
    expect(imageTypeOf(text(licensed), "logo")).toBe("image/svg+xml");
  });

  test("a GIF, a page of HTML, plain text or nothing is not an image a page takes", () => {
    for (const value of [
      bytes(gifBytes),
      text("<!doctype html><html><body><svg/></body></html>"),
      text("just text"),
      bytes([]),
      bytes([137, 80, 78]),
    ]) {
      expect(imageTypeOf(value, "logo")).toBeUndefined();
    }
  });

  test("a RIFF file that is not WebP is refused", () => {
    const wav = [...text("RIFF"), 36, 0, 0, 0, ...text("WAVEfmt ")];
    expect(imageTypeOf(bytes(wav), "logo")).toBeUndefined();
  });
});

async function withPage(): Promise<{ id: string; scratch: PagesScratch }> {
  scratch = await scratchPages();
  const created = await createPage(scratch.storage, {
    locale: "ar",
    slug: "status",
    title: "حالة",
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  return { id: created.page.id, scratch };
}

function sha256(values: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(values).digest("hex");
}

describe("uploading a page's image", () => {
  test("a file is stored as what its bytes say, whatever type the browser sent, under its SHA-256, and moves the change counter", async () => {
    const { id, scratch: s } = await withPage();
    const before = await s.storage.changeCounter();
    const file = new Blob([bytes(pngBytes)], { type: "image/jpeg" });
    const result = await uploadPageImage(s.storage, id, "logo", file);
    expect(result).toEqual({
      image: {
        contentType: "image/png",
        hash: sha256(bytes(pngBytes)),
        kind: "logo",
      },
      ok: true,
    });
    expect((await s.storage.pages.image(id, "logo"))?.body).toEqual(
      bytes(pngBytes)
    );
    expect(await s.storage.changeCounter()).toBe(before + 1);
  });

  test("a file that is not an accepted image is refused and nothing is stored", async () => {
    const { id, scratch: s } = await withPage();
    expect(
      await uploadPageImage(s.storage, id, "logo", new Blob([bytes(gifBytes)]))
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await s.storage.pages.images(id)).toEqual([]);
  });

  test("each kind has its own size cap, checked before the file is read", async () => {
    const { id, scratch: s } = await withPage();
    const over = (limit: number) =>
      new Blob([bytes(pngBytes), new Uint8Array(limit)]);
    expect(
      await uploadPageImage(
        s.storage,
        id,
        "favicon",
        over(pageImageMaxBytes.favicon)
      )
    ).toEqual({ ok: false, reason: "too_large" });
    expect(
      await uploadPageImage(s.storage, id, "logo", over(pageImageMaxBytes.logo))
    ).toEqual({ ok: false, reason: "too_large" });
    const cover = await uploadPageImage(
      s.storage,
      id,
      "cover",
      over(pageImageMaxBytes.logo)
    );
    expect(cover.ok).toBe(true);
    expect(
      await uploadPageImage(
        s.storage,
        id,
        "cover",
        over(pageImageMaxBytes.cover)
      )
    ).toEqual({ ok: false, reason: "too_large" });
  });

  test("an image for an unknown page is not found", async () => {
    const { scratch: s } = await withPage();
    expect(
      await uploadPageImage(
        s.storage,
        "nope",
        "logo",
        new Blob([bytes(pngBytes)])
      )
    ).toEqual({ ok: false, reason: "not_found" });
  });

  test("removing an image deletes it and moves the change counter; removing one that is not there changes nothing", async () => {
    const { id, scratch: s } = await withPage();
    await uploadPageImage(s.storage, id, "logo", new Blob([bytes(pngBytes)]));
    const before = await s.storage.changeCounter();
    expect(await removePageImage(s.storage, id, "logo")).toEqual({
      image: undefined,
      ok: true,
    });
    expect(await s.storage.pages.images(id)).toEqual([]);
    expect(await s.storage.changeCounter()).toBe(before + 1);
    expect(await removePageImage(s.storage, id, "logo")).toEqual({
      image: undefined,
      ok: true,
    });
    expect(await s.storage.changeCounter()).toBe(before + 1);
  });

  test("removing an image of an unknown page is not found", async () => {
    const { scratch: s } = await withPage();
    expect(await removePageImage(s.storage, "nope", "logo")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("a database that does not answer is unavailable, never a throw", async () => {
    const { id, scratch: s } = await withPage();
    await s.cleanup();
    scratch = undefined;
    expect(
      await uploadPageImage(s.storage, id, "logo", new Blob([bytes(pngBytes)]))
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});

/** A request with no operator session. */
const visitor = () => Promise.resolve(false);

describe("a page image's public answer", () => {
  async function stored(): Promise<{
    hash: string;
    id: string;
    s: PagesScratch;
  }> {
    const { id, scratch: s } = await withPage();
    await publish(s.storage, id);
    await uploadPageImage(s.storage, id, "logo", new Blob([text(svgText)]));
    return { hash: sha256(text(svgText)), id, s };
  }

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://status.example.test${path}`, { headers });

  test("the image is answered with its type, a sandbox policy so an SVG runs nothing, and no sniffing", async () => {
    const { hash, id, s } = await stored();
    const response = await pageImageResponse(
      s.storage,
      id,
      "logo",
      get(`/api/pages/${id}/logo?v=${hash}`),
      visitor
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(`"${hash}"`);
    expect(await response.text()).toBe(svgText);
  });

  test("a URL carrying the image's hash is cached for a year; any other is revalidated", async () => {
    const { hash, id, s } = await stored();
    const current = await pageImageResponse(
      s.storage,
      id,
      "logo",
      get(`/api/pages/${id}/logo?v=${hash}`),
      visitor
    );
    expect(current.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    const others = await Promise.all(
      [`/api/pages/${id}/logo`, `/api/pages/${id}/logo?v=an-old-hash`].map(
        (path) => pageImageResponse(s.storage, id, "logo", get(path), visitor)
      )
    );
    for (const response of others) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=0, must-revalidate"
      );
    }
  });

  test("a browser holding the image gets 304, by its tag, a weak tag or a list of tags that holds it", async () => {
    const { hash, id, s } = await stored();
    const answers = await Promise.all(
      [`"${hash}"`, `W/"${hash}"`, `"other", "${hash}"`, `"other"`].map((tag) =>
        pageImageResponse(
          s.storage,
          id,
          "logo",
          get(`/api/pages/${id}/logo`, { "if-none-match": tag }),
          visitor
        )
      )
    );
    expect(answers.map((response) => response.status)).toEqual([
      304, 304, 304, 200,
    ]);
  });

  test("HEAD answers the headers alone", async () => {
    const { hash, id, s } = await stored();
    const response = await pageImageResponse(
      s.storage,
      id,
      "logo",
      new Request(
        `https://status.example.test/api/pages/${id}/logo?v=${hash}`,
        {
          method: "HEAD",
        }
      ),
      visitor
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toBe("");
  });

  test("an unknown page, an unknown kind or a kind with no image is not found", async () => {
    const { id, s } = await stored();
    const answers = await Promise.all(
      [
        ["nope", "logo"],
        [id, "banner"],
        [id, "cover"],
      ].map(([page = "", kind = ""]) =>
        pageImageResponse(
          s.storage,
          page,
          kind,
          get(`/api/pages/${page}/${kind}`),
          visitor
        )
      )
    );
    expect(answers.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  test("with no database the answer is 503, never cached", async () => {
    const response = await pageImageResponse(
      undefined,
      "id",
      "logo",
      get("/api/pages/id/logo"),
      visitor
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a database that does not answer is 503, never a throw", async () => {
    const { id, s } = await stored();
    await s.cleanup();
    scratch = undefined;
    const response = await pageImageResponse(
      s.storage,
      id,
      "logo",
      get(`/api/pages/${id}/logo`),
      visitor
    );
    expect(response.status).toBe(503);
  });

  test("an unpublished page's image is not found to a visitor, and the signed-in operator gets it never stored", async () => {
    const { id, scratch: s } = await withPage();
    await uploadPageImage(s.storage, id, "logo", new Blob([text(svgText)]));
    const path = `/api/pages/${id}/logo?v=${sha256(text(svgText))}`;
    const hidden = await pageImageResponse(
      s.storage,
      id,
      "logo",
      get(path),
      visitor
    );
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
    const shown = await pageImageResponse(
      s.storage,
      id,
      "logo",
      get(path),
      () => Promise.resolve(true)
    );
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.text()).toBe(svgText);
  });

  test("a published page's image costs no session read", async () => {
    const { hash, id, s } = await stored();
    let reads = 0;
    const response = await pageImageResponse(
      s.storage,
      id,
      "logo",
      get(`/api/pages/${id}/logo?v=${hash}`),
      () => {
        reads += 1;
        return Promise.resolve(false);
      }
    );
    expect(response.status).toBe(200);
    expect(reads).toBe(0);
  });
});
