/**
 * The chunk: a sealed day's checks packed column by column and compressed
 * (CONTEXT.md "Sealed day", ADR-0005). Byte 0 is the format
 * version, left uncompressed; the rest is zstd at level 3 over the payload.
 * Version 1's payload, every varint unsigned LEB128 and every signed value
 * zigzagged:
 *
 *   the check count, a varint;
 *   started-at, the delta of deltas from the day's start, varints;
 *   the response time plus one (0 for none), deltas, varints;
 *   the bytes read, deltas, varints;
 *   the result, one byte each;
 *   the reason code, one byte each;
 *   the attempts, one byte each;
 *   the status code (0 for none), two bytes each, little-endian.
 *
 * The monitor and the day are the row's key and are not in the chunk. A
 * decoder for every past version ships forever; only storage reads a chunk.
 */
import { type Check, resultCode, resultOf } from "@/shared/schemas/check.ts";
import { type ReasonCode, reasonName } from "@/shared/schemas/reason.ts";

/** The version every new chunk is written in. */
export const chunkVersion = 1;

/** A sealed day's checks column by column, oldest first; index `i` of every column is one check. */
export interface ChunkColumns {
  readonly attempts: Uint8Array;
  readonly bytes: Float64Array;
  readonly reason: Uint8Array;
  /** -1 where the check had no response time. */
  readonly responseMs: Float64Array;
  /** The stored result code (`resultCode`). */
  readonly result: Uint8Array;
  readonly startedAt: Float64Array;
  /** 0 where the check had no status code. */
  readonly statusCode: Uint16Array;
}

/** Thrown by the decoder for bytes that are not a chunk of a version it knows; storage names the monitor and the day. */
export class ChunkFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChunkFormatError";
  }
}

const dayMs = 86_400_000;

/** Packs one day's checks, oldest first and all inside the day that starts at `day`; throws a RangeError for a check that does not fit the format. */
export function encodeChunk(day: number, checks: readonly Check[]): Uint8Array {
  const out: number[] = [];
  varint(out, checks.length);
  let previous = day;
  let previousDelta = 0;
  for (const [index, check] of checks.entries()) {
    fits(check.startedAt - day, dayMs - 1, "started-at");
    if (index > 0 && check.startedAt <= previous) {
      throw new RangeError(
        "the checks are not oldest first, one per millisecond"
      );
    }
    const delta = check.startedAt - previous;
    varint(out, zigzag(delta - previousDelta));
    previous = check.startedAt;
    previousDelta = delta;
  }
  deltas(
    out,
    checks.map((check) =>
      check.responseMs === undefined
        ? 0
        : fits(check.responseMs, Number.MAX_SAFE_INTEGER - 1, "response time") +
          1
    )
  );
  deltas(
    out,
    checks.map((check) => fits(check.bytes, Number.MAX_SAFE_INTEGER, "bytes"))
  );
  for (const check of checks) {
    out.push(resultCode(check.result));
  }
  for (const check of checks) {
    out.push(fits(check.reason, 255, "reason"));
  }
  for (const check of checks) {
    out.push(fits(check.attempts, 255, "attempts"));
  }
  for (const check of checks) {
    const status =
      check.statusCode === undefined
        ? 0
        : fits(check.statusCode, 65_535, "status code");
    if (check.statusCode === 0) {
      throw new RangeError("a status code of 0 would read back as none");
    }
    out.push(status % 256, Math.floor(status / 256));
  }
  const compressed = Bun.zstdCompressSync(Uint8Array.from(out), { level: 3 });
  const chunk = new Uint8Array(1 + compressed.length);
  chunk[0] = chunkVersion;
  chunk.set(compressed, 1);
  return chunk;
}

/** The columns of a chunk of the day that starts at `day`; throws ChunkFormatError for bytes it cannot read. */
export function decodeChunk(day: number, chunk: Uint8Array): ChunkColumns {
  if (chunk[0] !== chunkVersion) {
    throw new ChunkFormatError(
      chunk.length === 0
        ? "the chunk is empty"
        : `the chunk's version ${chunk[0]} is not one this build reads`
    );
  }
  let payload: Uint8Array;
  try {
    payload = Bun.zstdDecompressSync(chunk.subarray(1));
  } catch (error) {
    throw new ChunkFormatError("the chunk is not zstd", { cause: error });
  }
  const reader = new Reader(payload);
  const count = reader.varint();
  // Every check takes at least eight bytes, so a larger count is not a chunk.
  if (count * 8 > payload.length) {
    throw new ChunkFormatError("the chunk's count is past its bytes");
  }
  const columns = {
    attempts: new Uint8Array(count),
    bytes: new Float64Array(count),
    reason: new Uint8Array(count),
    responseMs: new Float64Array(count),
    result: new Uint8Array(count),
    startedAt: new Float64Array(count),
    statusCode: new Uint16Array(count),
  };
  let previous = day;
  let previousDelta = 0;
  for (let index = 0; index < count; index += 1) {
    previousDelta += unzigzag(reader.varint());
    previous += previousDelta;
    columns.startedAt[index] = previous;
  }
  let response = 0;
  for (let index = 0; index < count; index += 1) {
    response += unzigzag(reader.varint());
    columns.responseMs[index] = response - 1;
  }
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    bytes += unzigzag(reader.varint());
    columns.bytes[index] = bytes;
  }
  columns.result.set(reader.bytes(count));
  columns.reason.set(reader.bytes(count));
  columns.attempts.set(reader.bytes(count));
  const status = reader.bytes(2 * count);
  for (let index = 0; index < count; index += 1) {
    columns.statusCode[index] =
      (status[2 * index] ?? 0) + 256 * (status[2 * index + 1] ?? 0);
  }
  if (!reader.done()) {
    throw new ChunkFormatError("the chunk has bytes past its checks");
  }
  return columns;
}

/** Check `index` of the columns as a check of `monitorId`, or nothing when its result or reason code is one this version does not know. */
export function checkAt(
  columns: ChunkColumns,
  index: number,
  monitorId: string
): Check | undefined {
  const result = resultOf(columns.result[index] ?? -1);
  const reason = columns.reason[index] ?? -1;
  if (!(result && reasonName(reason))) {
    return;
  }
  const responseMs = columns.responseMs[index] ?? -1;
  const statusCode = columns.statusCode[index] ?? 0;
  return {
    attempts: columns.attempts[index] ?? 0,
    bytes: columns.bytes[index] ?? 0,
    monitorId,
    reason: reason as ReasonCode,
    responseMs: responseMs < 0 ? undefined : responseMs,
    result,
    startedAt: columns.startedAt[index] ?? 0,
    statusCode: statusCode === 0 ? undefined : statusCode,
  };
}

/** The value when it is a whole number from 0 to `max`; a RangeError naming the column otherwise. */
function fits(value: number, max: number, column: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${value} does not fit the chunk's ${column}`);
  }
  return value;
}

function zigzag(value: number): number {
  return value < 0 ? -2 * value - 1 : 2 * value;
}

function unzigzag(value: number): number {
  return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
}

/** Unsigned LEB128 in arithmetic, so values past 32 bits stay exact. */
function varint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

function deltas(out: number[], values: readonly number[]): void {
  let previous = 0;
  for (const value of values) {
    varint(out, zigzag(value - previous));
    previous = value;
  }
}

/** Reads a payload front to back; running past its end is a ChunkFormatError. */
class Reader {
  private position = 0;
  private readonly payload: Uint8Array;

  constructor(payload: Uint8Array) {
    this.payload = payload;
  }

  bytes(count: number): Uint8Array {
    const end = this.position + count;
    if (end > this.payload.length) {
      throw new ChunkFormatError("the chunk ends before its checks do");
    }
    const bytes = this.payload.subarray(this.position, end);
    this.position = end;
    return bytes;
  }

  done(): boolean {
    return this.position === this.payload.length;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    // Eight bytes carry 56 bits, past any value the chunk holds.
    for (let length = 0; length < 8; length += 1) {
      const byte = this.payload[this.position];
      if (byte === undefined) {
        throw new ChunkFormatError("the chunk ends inside a number");
      }
      this.position += 1;
      value += (byte % 128) * scale;
      if (byte < 128) {
        return value;
      }
      scale *= 128;
    }
    throw new ChunkFormatError("the chunk holds a number past 56 bits");
  }
}
