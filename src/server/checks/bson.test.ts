import { describe, expect, test } from "bun:test";
import {
  BsonError,
  bsonDepthMax,
  decodeDocument,
  type ExtendedDocument,
  type ExtendedJson,
  encodeDocument,
  parseExtendedJson,
  relaxed,
} from "./bson.ts";

const hex = (text: string) => Uint8Array.fromHex(text.replaceAll(" ", ""));

describe("a BSON document", () => {
  test("decodes to canonical Extended JSON, each type kept apart", () => {
    // {"i": int32 1, "d": double 1.0, "l": int64 1, "s": "x", "b": true, "n": null}
    const bytes = encodeDocument({
      b: true,
      d: { $numberDouble: "1.0" },
      i: { $numberInt: "1" },
      l: { $numberLong: "1" },
      n: null,
      s: "x",
    });
    expect(decodeDocument(bytes)).toEqual({
      b: true,
      d: { $numberDouble: "1.0" },
      i: { $numberInt: "1" },
      l: { $numberLong: "1" },
      n: null,
      s: "x",
    });
  });

  test("encodes a plain integer that fits 32 bits as an int32, a wider one as an int64, any other number as a double", () => {
    const decoded = decodeDocument(
      encodeDocument({
        big: 2 ** 40,
        fraction: 0.5,
        highest: 2 ** 31 - 1,
        lowest: -(2 ** 31),
        past: 2 ** 31,
        small: 1,
      })
    );
    expect(decoded).toEqual({
      big: { $numberLong: String(2 ** 40) },
      fraction: { $numberDouble: "0.5" },
      highest: { $numberInt: "2147483647" },
      lowest: { $numberInt: "-2147483648" },
      past: { $numberLong: "2147483648" },
      small: { $numberInt: "1" },
    });
  });

  test("keeps a key named __proto__ as a key, never as the object's prototype", () => {
    const decoded = decodeDocument(
      encodeDocument(
        parseExtendedJson('{"__proto__": {"polluted": true}}') as never
      )
    );
    expect(Object.keys(decoded)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });

  test("with a key repeated keeps the last value", () => {
    // { 'foo': 1, 'foo': 2 }
    expect(
      decodeDocument(hex("1700000010666f6f000100000010666f6f000200000000"))
    ).toEqual({ foo: { $numberInt: "2" } });
  });

  test.each([
    ["shorter than its length says", "0600000000"],
    ["longer than its length says", "050000000000"],
    ["without its closing zero", "0500000001"],
    ["a length below five", "04000000"],
    [
      "a string whose length runs past the document",
      "0f000000 02 6100 64000000 616200 00",
    ],
    ["a string that is not UTF-8", "0f000000 02 6100 03000000 ffff00 00"],
    ["an unknown element type", "0800000020610000"],
    [
      "an embedded document longer than its parent",
      "0d0000000361001000000000 00",
    ],
  ])("refuses bytes %s", (_, bytes) => {
    expect(() => decodeDocument(hex(bytes))).toThrow(BsonError);
  });

  test("refuses code with scope whose length counts a byte past its parts", () => {
    const valid = encodeDocument({ a: { $code: "x", $scope: {} } });
    // The element's own length grows by one, the document by one, and a stray byte sits before the end.
    const padded = new Uint8Array(valid.length + 1);
    padded.set(valid.subarray(0, valid.length - 1));
    const view = new DataView(padded.buffer);
    view.setInt32(0, padded.length, true);
    view.setInt32(7, view.getInt32(7, true) + 1, true);
    padded[valid.length - 1] = 0x01;
    padded[valid.length] = 0;
    expect(() => decodeDocument(padded)).toThrow(BsonError);
  });

  /** A document holding `levels` documents (type 3) or arrays (type 4), each inside the one before. */
  function nested(levels: number, type: 3 | 4): Uint8Array {
    let inner = new Uint8Array([5, 0, 0, 0, 0]);
    for (let depth = 0; depth < levels; depth += 1) {
      const outer = new Uint8Array(inner.length + 8);
      new DataView(outer.buffer).setInt32(0, outer.length, true);
      // An array's keys are its indexes: "0".
      outer.set([type, type === 4 ? 48 : 97, 0], 4);
      outer.set(inner, 7);
      inner = outer;
    }
    return inner;
  }

  test("refuses nesting deeper than its cap without recursing into it, of documents and of arrays", () => {
    for (const type of [3, 4] as const) {
      expect(() => decodeDocument(nested(bsonDepthMax, type))).not.toThrow();
      expect(() => decodeDocument(nested(bsonDepthMax + 1, type))).toThrow(
        "documents nest past the cap"
      );
    }
  });

  /** A command holding `levels` documents or arrays, each inside the one before, an empty document innermost. */
  function nestedCommand(levels: number, inArray: boolean): ExtendedDocument {
    let value: ExtendedJson = {};
    for (let depth = 1; depth < levels; depth += 1) {
      value = inArray ? [value] : { a: value };
    }
    return { a: value };
  }

  test("encodes a command nested to its cap and refuses one deeper, of documents and of arrays", () => {
    for (const inArray of [false, true]) {
      expect(() =>
        encodeDocument(nestedCommand(bsonDepthMax, inArray))
      ).not.toThrow();
      expect(() =>
        encodeDocument(nestedCommand(bsonDepthMax + 1, inArray))
      ).toThrow("documents nest past the cap");
    }
  });

  test("refuses to encode a key or a pattern holding a zero byte", () => {
    expect(() => encodeDocument({ "a\u0000b": 1 })).toThrow(BsonError);
    expect(() => encodeDocument({ a: { "b\u0000": 1 } })).toThrow(BsonError);
    expect(() =>
      encodeDocument({
        a: { $regularExpression: { options: "", pattern: "a\u0000" } },
      })
    ).toThrow(BsonError);
    expect(() =>
      encodeDocument({
        a: { $regularExpression: { options: "i\u0000", pattern: "a" } },
      })
    ).toThrow(BsonError);
  });

  test("never encodes a Decimal128, which the monitor only reads", () => {
    expect(() => encodeDocument({ a: { $numberDecimal: "1.5" } })).toThrow(
      BsonError
    );
  });
});

describe("Extended JSON text", () => {
  test("reads 1 as an int32, 1.0 as a double and a wide integer as an int64", () => {
    expect(
      parseExtendedJson(
        '{"a": 1, "b": 1.0, "c": 4294967296, "d": 2147483647, "e": -2147483648}'
      )
    ).toEqual({
      a: { $numberInt: "1" },
      b: { $numberDouble: "1.0" },
      c: { $numberLong: "4294967296" },
      d: { $numberInt: "2147483647" },
      e: { $numberInt: "-2147483648" },
    });
  });

  test("reads an ObjectId and a date as an operator writes them in a filter", () => {
    const bytes = encodeDocument(
      parseExtendedJson(
        '{"_id": {"$oid": "5f1d7c3e9a1b2c3d4e5f6a7b"}, "at": {"$date": "2026-11-09T00:00:00Z"}}'
      ) as never
    );
    expect(decodeDocument(bytes)).toEqual({
      _id: { $oid: "5f1d7c3e9a1b2c3d4e5f6a7b" },
      at: { $date: { $numberLong: String(Date.UTC(2026, 10, 9)) } },
    });
  });

  test.each([
    ["an ObjectId that is not 24 hex digits", '{"a": {"$oid": "123"}}'],
    ["a wrapper with a key too many", '{"a": {"$numberInt": "1", "x": 1}}'],
    ["an int32 past its range", '{"a": {"$numberInt": "2147483648"}}'],
    ["a date that is no date", '{"a": {"$date": "yesterday"}}'],
  ])("refuses %s when encoded", (_, text) => {
    expect(() => encodeDocument(parseExtendedJson(text) as never)).toThrow(
      BsonError
    );
  });
});

describe("the relaxed form of a value", () => {
  test("shows numbers as numbers and a date as ISO 8601, as people read them", () => {
    expect(
      relaxed({
        d: { $numberDouble: "1.5" },
        i: { $numberInt: "1" },
        l: { $numberLong: "42" },
        when: { $date: { $numberLong: String(Date.UTC(2026, 0, 2)) } },
      })
    ).toEqual({
      d: 1.5,
      i: 1,
      l: 42,
      when: { $date: "2026-01-02T00:00:00Z" },
    });
  });

  test("leaves a document whose key is a name on Object.prototype as it is", () => {
    const document = JSON.parse(
      '{"x": {"__proto__": 1}, "y": {"toString": 2}, "z": {"constructor": "c"}, "w": {"hasOwnProperty": null}}'
    ) as ExtendedDocument;
    expect(relaxed(document)).toEqual(document);
  });

  test("keeps what a JSON number cannot hold in its canonical form", () => {
    expect(relaxed({ $numberDouble: "NaN" })).toEqual({ $numberDouble: "NaN" });
    expect(relaxed({ $numberLong: "9007199254740993" })).toEqual({
      $numberLong: "9007199254740993",
    });
  });
});
