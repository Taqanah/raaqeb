import { describe, expect, test } from "bun:test";
import { compressLines, readLines, UnreadableFileError } from "./lines.ts";

async function all(lines: AsyncIterable<string>): Promise<string[]> {
  const read: string[] = [];
  for await (const line of lines) {
    read.push(line);
  }
  return read;
}

/** A stream that hands over its bytes a few at a time, so a character and a line break land across chunks. */
function trickle(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull: (controller) => {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function refusal(
  lines: AsyncIterable<string>
): Promise<UnreadableFileError | undefined> {
  try {
    await all(lines);
  } catch (error) {
    if (error instanceof UnreadableFileError) {
      return error;
    }
    throw error;
  }
}

describe("JSON Lines under zstd", () => {
  test("lines written come back in order, each without its line break", async () => {
    const written = ['{"a":1}', "حالة الخدمات", "", '{"b":2}'];
    expect(await all(readLines(compressLines(written)))).toEqual(written);
  });

  test("the file is zstd, one line break after each line", async () => {
    const bytes = new Uint8Array(
      await new Response(compressLines(["one", "two"])).arrayBuffer()
    );
    expect([...bytes.slice(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(bytes))).toBe(
      "one\ntwo\n"
    );
  });

  test("a character or a line break split across chunks is read whole", async () => {
    const bytes = new Uint8Array(
      Bun.zstdCompressSync(new TextEncoder().encode("مرحبا\nسلام\n"))
    );
    expect(await all(readLines(trickle(bytes, 1)))).toEqual(["مرحبا", "سلام"]);
  });

  test("a last line with no line break after it is still a line", async () => {
    const bytes = new Uint8Array(
      Bun.zstdCompressSync(new TextEncoder().encode("one\ntwo"))
    );
    expect(await all(readLines(trickle(bytes, 3)))).toEqual(["one", "two"]);
  });

  test("an empty file has no lines", async () => {
    const bytes = new Uint8Array(Bun.zstdCompressSync(new Uint8Array()));
    expect(await all(readLines(trickle(bytes, 4)))).toEqual([]);
  });

  test("a line exactly as long as the reader takes is read", async () => {
    const text = `${"x".repeat(1000)}\nlast\n`;
    const bytes = new Uint8Array(
      Bun.zstdCompressSync(new TextEncoder().encode(text))
    );
    expect(await all(readLines(trickle(bytes, 64), 1000))).toHaveLength(2);
  });

  test("bytes that are not zstd are refused at the first line", async () => {
    const error = await refusal(
      readLines(new Blob(["not zstd at all"]).stream())
    );
    expect(error?.line).toBe(1);
  });

  test("a line longer than the reader takes is refused by its number, before it is held whole", async () => {
    const text = `short\n${"x".repeat(5000)}\nlast\n`;
    const bytes = new Uint8Array(
      Bun.zstdCompressSync(new TextEncoder().encode(text))
    );
    const error = await refusal(readLines(trickle(bytes, 64), 1000));
    expect(error?.line).toBe(2);
  });

  test("a last line past the limit with no line break after it is refused too", async () => {
    const bytes = new Uint8Array(
      Bun.zstdCompressSync(
        new TextEncoder().encode(`short\n${"x".repeat(5000)}`)
      )
    );
    const error = await refusal(readLines(trickle(bytes, 64), 1000));
    expect(error?.line).toBe(2);
  });

  test("bytes that are not UTF-8 are refused by their line", async () => {
    const bytes = new Uint8Array(
      Bun.zstdCompressSync(new Uint8Array([0x61, 0x0a, 0xff, 0xfe, 0x0a]))
    );
    const error = await refusal(readLines(trickle(bytes, 2)));
    expect(error?.line).toBe(2);
  });
});
