/**
 * BSON (bsonspec.org) for the MongoDB monitor, with MongoDB's Extended JSON
 * as its only value model: a decoded document is canonical Extended JSON, so
 * no BSON type is lost or guessed, and the encoder reads canonical or relaxed
 * Extended JSON, which is also what an operator writes as a command. Decoding
 * is total over hostile bytes: every length is bounds-checked before it is
 * read, nesting is capped, and any malformed input throws a `BsonError`.
 * Decimal128 is decoded to its string; it is never encoded.
 */
// biome-ignore-all lint/suspicious/noBitwiseOperators: a Decimal128 and a Timestamp are bit fields, read and written by shifts and masks

/** A JSON value as Extended JSON writes one. */
export type ExtendedJson =
  | string
  | number
  | boolean
  | null
  | readonly ExtendedJson[]
  | ExtendedDocument;

/** A document, its keys in the order they were read. */
export interface ExtendedDocument {
  readonly [key: string]: ExtendedJson;
}

/** Bytes that are not BSON, or a value BSON cannot hold. */
export class BsonError extends Error {
  override readonly name = "BsonError";
}

/** Deeper nesting is refused rather than recursed into. */
export const bsonDepthMax = 100;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function fail(message: string): never {
  throw new BsonError(message);
}

/** Decodes one BSON document that fills `bytes` exactly into canonical Extended JSON. */
export function decodeDocument(bytes: Uint8Array): ExtendedDocument {
  const reader = new Reader(bytes);
  const { end, value } = reader.document(0, 0, false);
  if (end !== bytes.length) {
    fail("bytes follow the document");
  }
  return value as ExtendedDocument;
}

/** Reads values at offsets, checking each length against the end it must stay within. */
class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Fails unless `count` bytes from `offset` lie before `end`. */
  #need(offset: number, count: number, end: number): void {
    if (count < 0 || offset + count > end) {
      fail("a length runs past its document");
    }
  }

  int32(offset: number, end: number): number {
    this.#need(offset, 4, end);
    return this.#view.getInt32(offset, true);
  }

  document(
    offset: number,
    depth: number,
    array: boolean,
    limit = this.#bytes.length
  ): { end: number; value: ExtendedJson } {
    if (depth > bsonDepthMax) {
      fail("documents nest past the cap");
    }
    const size = this.int32(offset, limit);
    this.#need(offset, size, limit);
    const end = offset + size;
    if (this.#bytes[end - 1] !== 0) {
      fail("a document does not end in a zero byte");
    }
    const entries: [string, ExtendedJson][] = [];
    let at = offset + 4;
    for (;;) {
      this.#need(at, 1, end);
      const type = this.#bytes[at] ?? 0;
      at += 1;
      if (type === 0) {
        break;
      }
      const key = this.#cstring(at, end);
      const read = this.#value(type, key.end, end, depth);
      entries.push([key.value, read.value]);
      at = read.end;
    }
    if (at !== end) {
      fail("a document ends before its length says");
    }
    return {
      end,
      // A key such as __proto__ stays a key: fromEntries defines each one.
      value: array
        ? entries.map(([, value]) => value)
        : Object.fromEntries(entries),
    };
  }

  #cstring(offset: number, end: number): { end: number; value: string } {
    const zero = this.#bytes.indexOf(0, offset);
    if (zero < 0 || zero >= end) {
      fail("a name runs past its document");
    }
    return { end: zero + 1, value: this.#text(offset, zero) };
  }

  #text(from: number, to: number): string {
    try {
      return utf8.decode(this.#bytes.subarray(from, to));
    } catch {
      return fail("text that is not UTF-8");
    }
  }

  #string(offset: number, end: number): { end: number; value: string } {
    const length = this.int32(offset, end);
    if (length < 1) {
      fail("a string's length is below one");
    }
    this.#need(offset + 4, length, end);
    const stop = offset + 4 + length;
    if (this.#bytes[stop - 1] !== 0) {
      fail("a string does not end in a zero byte");
    }
    return { end: stop, value: this.#text(offset + 4, stop - 1) };
  }

  #hex(offset: number, count: number, end: number): string {
    this.#need(offset, count, end);
    return this.#bytes.subarray(offset, offset + count).toHex();
  }

  #int64(offset: number, end: number): bigint {
    this.#need(offset, 8, end);
    return this.#view.getBigInt64(offset, true);
  }

  #value(
    type: number,
    at: number,
    end: number,
    depth: number
  ): { end: number; value: ExtendedJson } {
    switch (type) {
      case 0x01: {
        this.#need(at, 8, end);
        const number = this.#view.getFloat64(at, true);
        return { end: at + 8, value: { $numberDouble: doubleText(number) } };
      }
      case 0x02:
        return this.#string(at, end);
      case 0x03:
        return this.document(at, depth + 1, false, end);
      case 0x04:
        return this.document(at, depth + 1, true, end);
      case 0x05:
        return this.#binary(at, end);
      case 0x06:
        return { end: at, value: { $undefined: true } };
      case 0x07:
        return { end: at + 12, value: { $oid: this.#hex(at, 12, end) } };
      case 0x08: {
        this.#need(at, 1, end);
        const flag = this.#bytes[at];
        if (flag !== 0 && flag !== 1) {
          fail("a boolean that is neither 0 nor 1");
        }
        return { end: at + 1, value: flag === 1 };
      }
      case 0x09:
        return {
          end: at + 8,
          value: { $date: { $numberLong: String(this.#int64(at, end)) } },
        };
      case 0x0a:
        return { end: at, value: null };
      case 0x0b: {
        const pattern = this.#cstring(at, end);
        const options = this.#cstring(pattern.end, end);
        return {
          end: options.end,
          value: {
            // Extended JSON's own key order.
            $regularExpression: {
              pattern: pattern.value,
              options: sortedText([...options.value]),
            },
          },
        };
      }
      case 0x0c: {
        const ref = this.#string(at, end);
        return {
          end: ref.end + 12,
          value: {
            $dbPointer: {
              $ref: ref.value,
              $id: { $oid: this.#hex(ref.end, 12, end) },
            },
          },
        };
      }
      case 0x0d: {
        const code = this.#string(at, end);
        return { end: code.end, value: { $code: code.value } };
      }
      case 0x0e: {
        const symbol = this.#string(at, end);
        return { end: symbol.end, value: { $symbol: symbol.value } };
      }
      case 0x0f:
        return this.#codeWithScope(at, end, depth);
      case 0x10:
        return {
          end: at + 4,
          value: { $numberInt: String(this.int32(at, end)) },
        };
      case 0x11: {
        this.#need(at, 8, end);
        return {
          end: at + 8,
          value: {
            $timestamp: {
              t: this.#view.getUint32(at + 4, true),
              i: this.#view.getUint32(at, true),
            },
          },
        };
      }
      case 0x12:
        return {
          end: at + 8,
          value: { $numberLong: String(this.#int64(at, end)) },
        };
      case 0x13: {
        this.#need(at, 16, end);
        return {
          end: at + 16,
          value: {
            $numberDecimal: decimalText(
              this.#view.getBigUint64(at, true),
              this.#view.getBigUint64(at + 8, true)
            ),
          },
        };
      }
      case 0x7f:
        return { end: at, value: { $maxKey: 1 } };
      case 0xff:
        return { end: at, value: { $minKey: 1 } };
      default:
        return fail(`an unknown element type 0x${type.toString(16)}`);
    }
  }

  #binary(at: number, end: number): { end: number; value: ExtendedJson } {
    const length = this.int32(at, end);
    this.#need(at + 5, length, end);
    const subType = this.#bytes[at + 4] ?? 0;
    let data = this.#bytes.subarray(at + 5, at + 5 + length);
    // The old binary subtype repeats the length inside, and Extended JSON shows what follows it.
    if (subType === 0x02) {
      const inner = length >= 4 ? this.int32(at + 5, end) : -1;
      if (inner !== length - 4) {
        fail("an old binary's inner length disagrees with its own");
      }
      data = data.subarray(4);
    }
    return {
      end: at + 5 + length,
      value: {
        $binary: {
          base64: data.toBase64(),
          subType: subType.toString(16).padStart(2, "0"),
        },
      },
    };
  }

  #codeWithScope(
    at: number,
    end: number,
    depth: number
  ): { end: number; value: ExtendedJson } {
    const size = this.int32(at, end);
    this.#need(at, size, end);
    const stop = at + size;
    const code = this.#string(at + 4, stop);
    const scope = this.document(code.end, depth + 1, false, stop);
    if (scope.end !== stop) {
      fail("code with scope is longer than its parts");
    }
    return { end: stop, value: { $code: code.value, $scope: scope.value } };
  }
}

const fractionOrExponent = /[.e]/;

/** A double as Extended JSON's decimal string: `1.0` for a whole number, the platform's shortest text otherwise. */
function doubleText(number: number): string {
  if (Number.isNaN(number)) {
    return "NaN";
  }
  if (!Number.isFinite(number)) {
    return number > 0 ? "Infinity" : "-Infinity";
  }
  if (Object.is(number, -0)) {
    return "-0.0";
  }
  const text = String(number);
  return fractionOrExponent.test(text) ? text : `${text}.0`;
}

const coefficientMax = 10n ** 34n - 1n;

/** A Decimal128's string by the Decimal128 specification: plain notation for a small exponent, scientific otherwise. */
function decimalText(low: bigint, high: bigint): string {
  const sign = high >> 63n === 1n ? "-" : "";
  const combination = (high >> 58n) & 0x1fn;
  if (combination === 0x1fn) {
    return "NaN";
  }
  if (combination === 0x1en) {
    return `${sign}Infinity`;
  }
  let exponent: bigint;
  let coefficient: bigint;
  if (combination >> 3n === 0x3n) {
    // The coefficient's implicit 100 prefix puts it past 10^34 - 1: a non-canonical zero.
    exponent = (high >> 47n) & 0x3fffn;
    coefficient = 0n;
  } else {
    exponent = (high >> 49n) & 0x3fffn;
    coefficient = ((high & 0x1_ffff_ffff_ffffn) << 64n) | low;
    if (coefficient > coefficientMax) {
      coefficient = 0n;
    }
  }
  const scale = Number(exponent) - 6176;
  const digits = coefficient.toString();
  const adjusted = scale + digits.length - 1;
  if (scale <= 0 && adjusted >= -6) {
    if (scale === 0) {
      return `${sign}${digits}`;
    }
    const point = digits.length + scale;
    return point > 0
      ? `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
      : `${sign}0.${"0".repeat(-point)}${digits}`;
  }
  const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
  return `${sign}${digits[0]}${fraction}E${adjusted >= 0 ? "+" : ""}${adjusted}`;
}

const int32Min = -(2 ** 31);
const int32Max = 2 ** 31 - 1;
const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;
const integerText = /^-?\d+$/;
const doubleTextShape = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const hexText = /^[0-9a-fA-F]*$/;
const uuidText =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const regexFlags = /^[ilmsux]*$/;

/** Builds bytes out of parts, little-endian as BSON writes them. */
class Writer {
  readonly parts: Uint8Array[] = [];
  length = 0;

  bytes(part: Uint8Array): void {
    this.parts.push(part);
    this.length += part.length;
  }

  byte(value: number): void {
    this.bytes(new Uint8Array([value]));
  }

  int32(value: number): void {
    const part = new Uint8Array(4);
    new DataView(part.buffer).setInt32(0, value, true);
    this.bytes(part);
  }

  int64(value: bigint): void {
    const part = new Uint8Array(8);
    new DataView(part.buffer).setBigInt64(0, value, true);
    this.bytes(part);
  }

  double(value: number): void {
    const part = new Uint8Array(8);
    new DataView(part.buffer).setFloat64(0, value, true);
    this.bytes(part);
  }

  cstring(text: string): void {
    if (text.includes("\u0000")) {
      fail("a name or pattern holds a zero byte");
    }
    this.bytes(encoder.encode(text));
    this.byte(0);
  }

  string(text: string): void {
    const bytes = encoder.encode(text);
    this.int32(bytes.length + 1);
    this.bytes(bytes);
    this.byte(0);
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Encodes a document of canonical or relaxed Extended JSON; a plain integer that fits 32 bits is an int32, a wider one an int64, any other number a double. */
export function encodeDocument(document: ExtendedDocument): Uint8Array {
  return documentBytes(Object.entries(document), 0);
}

function documentBytes(
  entries: [string, ExtendedJson][],
  depth: number
): Uint8Array {
  if (depth > bsonDepthMax) {
    fail("documents nest past the cap");
  }
  const body = new Writer();
  for (const [key, value] of entries) {
    const element = new Writer();
    const type = writeValue(element, value, depth);
    body.byte(type);
    body.cstring(key);
    for (const part of element.parts) {
      body.bytes(part);
    }
  }
  const out = new Writer();
  out.int32(body.length + 5);
  for (const part of body.parts) {
    out.bytes(part);
  }
  out.byte(0);
  return out.done();
}

/** Strings in code unit order, joined: a wrapper's keys and a regular expression's options. */
function sortedText(parts: readonly string[], separator = ""): string {
  return parts
    .toSorted((a, b) => {
      if (a === b) {
        return 0;
      }
      return a < b ? -1 : 1;
    })
    .join(separator);
}

/** The keys of each type wrapper: an object holding one of them must hold exactly one of these sets. */
const wrappers: readonly (readonly string[])[] = [
  ["$oid"],
  ["$symbol"],
  ["$numberInt"],
  ["$numberLong"],
  ["$numberDouble"],
  ["$numberDecimal"],
  ["$binary"],
  ["$uuid"],
  ["$code"],
  ["$code", "$scope"],
  ["$timestamp"],
  ["$regularExpression"],
  ["$dbPointer"],
  ["$date"],
  ["$minKey"],
  ["$maxKey"],
  ["$undefined"],
];
const wrapperKeys = new Set(wrappers.flat());

/** The wrapper an object is, by its keys; none for a plain document; throws for one that holds a wrapper's key among others. */
function wrapperOf(keys: string[]): string | undefined {
  if (!keys.some((key) => wrapperKeys.has(key))) {
    return;
  }
  const sorted = sortedText(keys, ",");
  const match = wrappers.find((shape) => shape.join(",") === sorted);
  return match?.join(",") ?? fail(`a type wrapper with other keys: ${sorted}`);
}

function isDocument(value: ExtendedJson): value is ExtendedDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: ExtendedJson | undefined, what: string): string {
  return typeof value === "string" ? value : fail(`${what} is not a string`);
}

/** A plain document, never a type wrapper such as a number parsed into one. */
function documentOf(
  value: ExtendedJson | undefined,
  what: string
): ExtendedDocument {
  return value !== undefined &&
    isDocument(value) &&
    wrapperOf(Object.keys(value)) === undefined
    ? value
    : fail(`${what} is not a document`);
}

/** A JSON number as a wrapper's field holds it, plain or as parsed Extended JSON. */
function numberOf(value: ExtendedJson | undefined, what: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (value !== undefined && isDocument(value)) {
    const inner = value.$numberInt ?? value.$numberLong;
    if (typeof inner === "string" && Object.keys(value).length === 1) {
      return Number(inner);
    }
  }
  return fail(`${what} is not a number`);
}

function int64Of(text: string, what: string): bigint {
  if (!integerText.test(text)) {
    fail(`${what} is not an integer`);
  }
  const value = BigInt(text);
  return value < int64Min || value > int64Max
    ? fail(`${what} is past 64 bits`)
    : value;
}

/** Writes one value's bytes and answers its element type. */
function writeValue(
  writer: Writer,
  value: ExtendedJson,
  depth: number
): number {
  if (typeof value === "string") {
    writer.string(value);
    return 0x02;
  }
  if (typeof value === "boolean") {
    writer.byte(value ? 1 : 0);
    return 0x08;
  }
  if (value === null) {
    return 0x0a;
  }
  if (typeof value === "number") {
    return writeNumber(writer, value);
  }
  if (Array.isArray(value)) {
    const items = value as readonly ExtendedJson[];
    writer.bytes(
      documentBytes(
        items.map((item, index) => [String(index), item]),
        depth + 1
      )
    );
    return 0x04;
  }
  const document = value as ExtendedDocument;
  const wrapper = wrapperOf(Object.keys(document));
  if (wrapper === undefined) {
    writer.bytes(documentBytes(Object.entries(document), depth + 1));
    return 0x03;
  }
  return writeWrapper(writer, wrapper, document, depth);
}

function writeNumber(writer: Writer, value: number): number {
  if (Number.isInteger(value) && value >= int32Min && value <= int32Max) {
    writer.int32(value);
    return 0x10;
  }
  if (Number.isSafeInteger(value)) {
    writer.int64(BigInt(value));
    return 0x12;
  }
  writer.double(value);
  return 0x01;
}

function writeWrapper(
  writer: Writer,
  wrapper: string,
  value: ExtendedDocument,
  depth: number
): number {
  switch (wrapper) {
    case "$oid":
      writer.bytes(objectId(value.$oid));
      return 0x07;
    case "$symbol":
      writer.string(stringOf(value.$symbol, "$symbol"));
      return 0x0e;
    case "$numberInt": {
      const text = stringOf(value.$numberInt, "$numberInt");
      const number = integerText.test(text) ? Number(text) : Number.NaN;
      if (!(number >= int32Min && number <= int32Max)) {
        fail("$numberInt is no 32-bit integer");
      }
      writer.int32(number);
      return 0x10;
    }
    case "$numberLong":
      writer.int64(
        int64Of(stringOf(value.$numberLong, "$numberLong"), "$numberLong")
      );
      return 0x12;
    case "$numberDouble":
      writer.double(doubleOf(stringOf(value.$numberDouble, "$numberDouble")));
      return 0x01;
    case "$numberDecimal":
      return fail("a Decimal128 is read, never written");
    case "$binary":
      writeBinary(writer, value.$binary);
      return 0x05;
    case "$uuid":
      writeUuid(writer, stringOf(value.$uuid, "$uuid"));
      return 0x05;
    case "$code":
      writer.string(stringOf(value.$code, "$code"));
      return 0x0d;
    case "$code,$scope": {
      const code = new Writer();
      code.string(stringOf(value.$code, "$code"));
      code.bytes(
        documentBytes(
          Object.entries(documentOf(value.$scope, "$scope")),
          depth + 1
        )
      );
      writer.int32(code.length + 4);
      writer.bytes(code.done());
      return 0x0f;
    }
    case "$timestamp":
      writeTimestamp(writer, documentOf(value.$timestamp, "$timestamp"));
      return 0x11;
    case "$regularExpression":
      writeRegex(
        writer,
        documentOf(value.$regularExpression, "$regularExpression")
      );
      return 0x0b;
    case "$dbPointer":
      writeDbPointer(writer, documentOf(value.$dbPointer, "$dbPointer"));
      return 0x0c;
    case "$date":
      writer.int64(dateOf(value.$date));
      return 0x09;
    case "$minKey":
      if (numberOf(value.$minKey, "$minKey") !== 1) {
        fail("$minKey is not 1");
      }
      return 0xff;
    case "$maxKey":
      if (numberOf(value.$maxKey, "$maxKey") !== 1) {
        fail("$maxKey is not 1");
      }
      return 0x7f;
    default:
      if (value.$undefined !== true) {
        fail("$undefined is not true");
      }
      return 0x06;
  }
}

function objectId(value: ExtendedJson | undefined): Uint8Array {
  const text = stringOf(value, "$oid");
  return text.length === 24 && hexText.test(text)
    ? Uint8Array.fromHex(text)
    : fail("$oid is not 24 hex digits");
}

function doubleOf(text: string): number {
  if (text === "Infinity" || text === "-Infinity" || text === "NaN") {
    return Number(text);
  }
  return doubleTextShape.test(text)
    ? Number(text)
    : fail("$numberDouble is not a decimal number");
}

function writeBinary(writer: Writer, value: ExtendedJson | undefined): void {
  const binary = documentOf(value, "$binary");
  const keys = sortedText(Object.keys(binary), ",");
  if (keys !== "base64,subType") {
    fail("$binary needs base64 and subType alone");
  }
  const subType = stringOf(binary.subType, "subType");
  if (!(subType.length >= 1 && subType.length <= 2 && hexText.test(subType))) {
    fail("subType is not one or two hex digits");
  }
  const data = base64Of(stringOf(binary.base64, "base64"));
  const kind = Number.parseInt(subType, 16);
  // The old binary subtype repeats the length inside.
  const inner = kind === 0x02 ? 4 : 0;
  writer.int32(data.length + inner);
  writer.byte(kind);
  if (inner > 0) {
    writer.int32(data.length);
  }
  writer.bytes(data);
}

function base64Of(text: string): Uint8Array {
  try {
    return Uint8Array.fromBase64(text);
  } catch {
    return fail("base64 that does not decode");
  }
}

function writeUuid(writer: Writer, text: string): void {
  if (!uuidText.test(text)) {
    fail("$uuid is not a UUID");
  }
  writer.int32(16);
  writer.byte(0x04);
  writer.bytes(Uint8Array.fromHex(text.replaceAll("-", "")));
}

function writeTimestamp(writer: Writer, value: ExtendedDocument): void {
  if (sortedText(Object.keys(value), ",") !== "i,t") {
    fail("$timestamp needs t and i alone");
  }
  const t = numberOf(value.t, "t");
  const i = numberOf(value.i, "i");
  for (const part of [i, t]) {
    if (!(Number.isInteger(part) && part >= 0 && part <= 0xff_ff_ff_ff)) {
      fail("$timestamp's t and i are 32-bit unsigned integers");
    }
  }
  writer.int64(BigInt.asIntN(64, (BigInt(t) << 32n) | BigInt(i)));
}

function writeRegex(writer: Writer, value: ExtendedDocument): void {
  if (sortedText(Object.keys(value), ",") !== "options,pattern") {
    fail("$regularExpression needs pattern and options alone");
  }
  const options = stringOf(value.options, "options");
  if (!regexFlags.test(options)) {
    fail("a regular expression option BSON does not know");
  }
  writer.cstring(stringOf(value.pattern, "pattern"));
  writer.cstring(sortedText([...options]));
}

function writeDbPointer(writer: Writer, value: ExtendedDocument): void {
  if (sortedText(Object.keys(value), ",") !== "$id,$ref") {
    fail("$dbPointer needs $ref and $id alone");
  }
  const id = value.$id;
  if (
    !(
      id !== undefined &&
      isDocument(id) &&
      wrapperOf(Object.keys(id)) === "$oid"
    )
  ) {
    fail("$dbPointer's $id is not an ObjectId");
  }
  writer.string(stringOf(value.$ref, "$ref"));
  writer.bytes(objectId(id.$oid));
}

/** A date's milliseconds: canonical `{"$numberLong"}`, or relaxed ISO 8601. */
function dateOf(value: ExtendedJson | undefined): bigint {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) || !isoDate.test(value)
      ? fail("$date is not an ISO 8601 date")
      : BigInt(ms);
  }
  const date = value !== undefined && isDocument(value) ? value : {};
  if (Object.keys(date).join(",") !== "$numberLong") {
    fail("$date is neither ISO 8601 nor $numberLong");
  }
  return int64Of(stringOf(date.$numberLong, "$numberLong"), "$date");
}

const isoDate =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Parses Extended JSON text, keeping what JSON.parse loses: `1` reads as an int32, `1.0` as a double. Throws a `SyntaxError` on text that is not JSON. */
export function parseExtendedJson(text: string): ExtendedJson {
  return JSON.parse(
    text,
    (_key, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") {
        return value;
      }
      const source = context?.source ?? String(value);
      if (!integerText.test(source)) {
        return { $numberDouble: doubleText(value) };
      }
      const integer = BigInt(source);
      if (integer >= int32Min && integer <= int32Max) {
        return { $numberInt: String(integer) };
      }
      return integer >= int64Min && integer <= int64Max
        ? { $numberLong: String(integer) }
        : { $numberDouble: doubleText(value) };
    }
  ) as ExtendedJson;
}

/** The last millisecond of the year 9999, past which a relaxed date stays canonical. */
const relaxedDateMax = 253_402_300_799_999;

/** The relaxed form of a canonical value, as people read it: numbers as JSON numbers, a date in the years 1970 to 9999 as ISO 8601. */
export function relaxed(value: ExtendedJson): ExtendedJson {
  if (Array.isArray(value)) {
    return (value as readonly ExtendedJson[]).map(relaxed);
  }
  if (!(typeof value === "object" && value !== null)) {
    return value;
  }
  const document = value as ExtendedDocument;
  const keys = Object.keys(document);
  const [only = ""] = keys;
  // Own keys only: a reply may name toString or __proto__, which every object inherits.
  if (keys.length === 1 && Object.hasOwn(relaxedWrappers, only)) {
    return relaxedWrappers[only]?.(document[only] ?? null) ?? document;
  }
  if (wrapperKeys.has(only)) {
    return document;
  }
  return Object.fromEntries(
    keys.map((key) => [key, relaxed(document[key] ?? null)])
  );
}

/** A number's or a date's relaxed form from its wrapper's value, or nothing where it keeps the canonical one. */
const relaxedWrappers: Readonly<
  Record<string, (inner: ExtendedJson) => ExtendedJson | undefined>
> = {
  $date: (inner) => {
    const ms = Number((inner as ExtendedDocument).$numberLong);
    return ms >= 0 && ms <= relaxedDateMax
      ? { $date: new Date(ms).toISOString().replace(".000Z", "Z") }
      : undefined;
  },
  $numberDouble: (inner) => {
    const number = Number(inner);
    return Number.isFinite(number) ? number : undefined;
  },
  $numberInt: (inner) => Number(inner),
  $numberLong: (inner) => {
    const number = Number(inner);
    return Number.isSafeInteger(number) ? number : undefined;
  },
};
