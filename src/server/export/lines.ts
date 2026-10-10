/**
 * JSON Lines under zstd, both ways: lines written
 * through Bun's `CompressionStream("zstd")`, and a compressed stream read
 * back one line at a time through `DecompressionStream("zstd")`, so neither
 * side holds more than a line.
 */

/** The longest line a reader takes, in bytes: the header carries the page images, and anything longer is not an export. */
export const maxLineBytes = 64 * 1024 * 1024;

/** How much text one chunk into the compressor gathers, so millions of short lines are not millions of chunks. */
const chunkChars = 64 * 1024;

/** The lines, each ended by a line break, compressed. */
export function compressLines(
  lines: Iterable<string> | AsyncIterable<string>
): ReadableStream<Uint8Array> {
  const iterator =
    Symbol.asyncIterator in lines
      ? lines[Symbol.asyncIterator]()
      : lines[Symbol.iterator]();
  return (
    new ReadableStream<string>({
      cancel: async () => {
        await iterator.return?.();
      },
      pull: async (controller) => {
        let text = "";
        while (text.length < chunkChars) {
          // biome-ignore lint/performance/noAwaitInLoops: the lines come one after another
          const next = await iterator.next();
          if (next.done) {
            if (text !== "") {
              controller.enqueue(text);
            }
            controller.close();
            return;
          }
          text += `${next.value}\n`;
        }
        controller.enqueue(text);
      },
    })
      .pipeThrough(new TextEncoderStream())
      // @ts-expect-error lib.dom's CompressionFormat lacks the "zstd" Bun takes; bun-types adds it only without the DOM lib (oven-sh/bun#25367)
      .pipeThrough(new CompressionStream("zstd"))
  );
}

/** Thrown by `readLines` when the bytes are not zstd, not UTF-8, or hold a line past `maxLineBytes`. */
export class UnreadableFileError extends Error {
  readonly line: number;
  constructor(line: number, options?: ErrorOptions) {
    super(`the file cannot be read at line ${line}`, options);
    this.name = "UnreadableFileError";
    this.line = line;
  }
}

/** The lines of a compressed stream, without their line breaks; an empty last line is no line. */
export async function* readLines(
  file: ReadableStream<Uint8Array>,
  maxBytes: number = maxLineBytes
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = 1;
  let parts: Uint8Array[] = [];
  let held = 0;
  const complete = (): string => {
    try {
      return decoder.decode(
        Bun.concatArrayBuffers(parts, Number.POSITIVE_INFINITY, true)
      );
    } catch (error) {
      throw new UnreadableFileError(line, { cause: error });
    }
  };
  try {
    const decompressed = file.pipeThrough(
      // @ts-expect-error lib.dom's CompressionFormat lacks the "zstd" Bun takes, and its writable side wants views over an ArrayBuffer alone; bun-types fixes both only without the DOM lib (oven-sh/bun#25367)
      new DecompressionStream("zstd")
    );
    for await (const chunk of decompressed) {
      let start = 0;
      for (
        let end = chunk.indexOf(0x0a);
        end !== -1;
        end = chunk.indexOf(0x0a, start)
      ) {
        held += end - start;
        if (held > maxBytes) {
          throw new UnreadableFileError(line);
        }
        parts.push(chunk.subarray(start, end));
        yield complete();
        line += 1;
        parts = [];
        held = 0;
        start = end + 1;
      }
      held += chunk.length - start;
      if (held > maxBytes) {
        throw new UnreadableFileError(line);
      }
      parts.push(chunk.subarray(start));
    }
  } catch (error) {
    // The decompressor's own error means the bytes are not zstd, or end early.
    throw error instanceof UnreadableFileError
      ? error
      : new UnreadableFileError(line, { cause: error });
  }
  if (held > 0) {
    yield complete();
  }
}
