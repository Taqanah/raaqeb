import { describe, expect, test } from "bun:test";
import { decodeDocument, encodeDocument } from "./bson.ts";
import {
  decodeReply,
  encodeMessage,
  messageFramer,
  opMsg,
  replyBytesMax,
} from "./mongodb-wire.ts";

/** A reply as a server frames it: its header, flags and sections given. */
function reply(
  responseTo: number,
  body: Uint8Array,
  { flags = 0, opCode = opMsg, kind = 0, trailer = new Uint8Array() } = {}
): Uint8Array {
  const length = 21 + body.length + trailer.length;
  const message = new Uint8Array(length);
  const view = new DataView(message.buffer);
  view.setInt32(0, length, true);
  view.setInt32(4, 99, true);
  view.setInt32(8, responseTo, true);
  view.setInt32(12, opCode, true);
  view.setUint32(16, flags, true);
  message[20] = kind;
  message.set(body, 21);
  message.set(trailer, 21 + body.length);
  return message;
}

const ok = encodeDocument({ ok: 1 });

describe("a request", () => {
  test("is an OP_MSG with its id, no flags and the command as its one body section", () => {
    const body = encodeDocument({ $db: "admin", ping: 1 });
    const message = encodeMessage(7, body);
    const view = new DataView(message.buffer);
    expect(view.getInt32(0, true)).toBe(message.length);
    expect(view.getInt32(4, true)).toBe(7);
    expect(view.getInt32(8, true)).toBe(0);
    expect(view.getInt32(12, true)).toBe(2013);
    expect(view.getUint32(16, true)).toBe(0);
    expect(message[20]).toBe(0);
    expect(decodeDocument(message.subarray(21))).toEqual(decodeDocument(body));
  });
});

describe("a reply", () => {
  test("answers the body of the request it responds to", () => {
    expect(decodeReply(reply(7, ok), 7)).toEqual({ ok: { $numberInt: "1" } });
  });

  test("with a checksum is read without its last four bytes", () => {
    const message = reply(7, ok, {
      flags: 1,
      trailer: new Uint8Array([1, 2, 3, 4]),
    });
    expect(decodeReply(message, 7)).toEqual({ ok: { $numberInt: "1" } });
  });

  test.each([
    ["to another request", reply(8, ok)],
    ["of another operation", reply(7, ok, { opCode: 1 })],
    [
      "saying more replies follow, which the client never asked for",
      reply(7, ok, { flags: 2 }),
    ],
    [
      "with a required flag the client does not know",
      reply(7, ok, { flags: 4 }),
    ],
    ["with a document sequence instead of a body", reply(7, ok, { kind: 1 })],
    ["with a section of an unknown kind", reply(7, ok, { kind: 9 })],
    [
      "with bytes after its body",
      reply(7, ok, { trailer: new Uint8Array([0]) }),
    ],
  ])("is refused %s", (_, message) => {
    expect(() => decodeReply(message, 7)).toThrow();
  });

  test("ignores an optional flag it does not know", () => {
    expect(decodeReply(reply(7, ok, { flags: 0x10_00_00 }), 7)).toEqual({
      ok: { $numberInt: "1" },
    });
  });
});

describe("the framer", () => {
  test("joins chunks into whole messages and splits chunks that hold several", () => {
    const one = reply(1, ok);
    const two = reply(2, ok);
    const frame = messageFramer();
    expect(frame(one.subarray(0, 3))).toEqual([]);
    expect(frame(one.subarray(3, 30))).toEqual([]);
    const both = new Uint8Array([...one.subarray(30), ...two]);
    expect(frame(both)).toEqual([one, two]);
  });

  test("refuses a message whose length is past the cap before it arrives", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setInt32(0, replyBytesMax + 1, true);
    expect(() => messageFramer()(header)).toThrow();
  });

  test("refuses a length too short to hold an OP_MSG", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setInt32(0, 25, true);
    expect(() => messageFramer()(header)).toThrow();
  });

  test("takes the smallest OP_MSG, an empty document, and waits for a message as long as the cap", () => {
    const smallest = reply(1, encodeDocument({}));
    expect(smallest).toHaveLength(26);
    expect(messageFramer()(smallest)).toEqual([smallest]);
    expect(decodeReply(smallest, 1)).toEqual({});
    const header = new Uint8Array(4);
    new DataView(header.buffer).setInt32(0, replyBytesMax, true);
    expect(messageFramer()(header)).toEqual([]);
  });
});
