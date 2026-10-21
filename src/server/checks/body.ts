/**
 * The platform's response body, read to a cap: what every check that reads an
 * answer shares, so a large page or a hostile server costs bounded memory and
 * bandwidth whichever check asked.
 */

/** At most this much body is read; the rest of the stream is cancelled. */
export const bodyReadBytes = 1_048_576;

/** Reads the body up to the cap and cancels the rest; the timeout signal covers this read too. `progress` keeps the count when the read fails. */
export async function readBody(
  response: Response,
  progress: { read: number },
  cap = bodyReadBytes
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let read = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of response.body) {
    chunks.push(chunk);
    read += chunk.byteLength;
    progress.read = Math.min(read, cap);
    if (read >= cap) {
      break;
    }
  }
  const body = new Uint8Array(Math.min(read, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const room = body.byteLength - offset;
    body.set(room < chunk.byteLength ? chunk.subarray(0, room) : chunk, offset);
    offset += chunk.byteLength;
    if (offset >= body.byteLength) {
      break;
    }
  }
  return body;
}
