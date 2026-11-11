/**
 * MongoDB's wire framing for one command at a time: OP_MSG (the message
 * specification) with a single body section out, and a reply checked against
 * the request it answers. A reply's length is checked before a byte of it is
 * kept, against a cap far below the server's own 48 MB limit, since the
 * monitor reads one small reply.
 */
// biome-ignore-all lint/suspicious/noBitwiseOperators: OP_MSG's flags are a bit field
import { decodeDocument, type ExtendedDocument } from "./bson.ts";

/** OP_MSG's operation code. */
export const opMsg = 2013;

/** A reply past this many bytes is refused; `serverStatus`, among the larger ones, runs to tens of kilobytes. */
export const replyBytesMax = 1_048_576;

/** The bytes of a message that are not a section: the header and the flags. */
const headerBytes = 20;
/** The smallest OP_MSG: the header, the flags, a section kind and an empty document. */
const messageBytesMin = headerBytes + 1 + 5;

const checksumPresent = 1;
/** The low 16 bits are required: one set that the client does not know, moreToCome among them, is an error; the high 16 are optional and ignored. */
const requiredBits = 0xff_ff;

/** Frames a command as an OP_MSG with no flags and one body section. */
export function encodeMessage(requestId: number, body: Uint8Array): Uint8Array {
  const message = new Uint8Array(headerBytes + 1 + body.length);
  const view = new DataView(message.buffer);
  view.setInt32(0, message.length, true);
  view.setInt32(4, requestId, true);
  view.setInt32(8, 0, true);
  view.setInt32(12, opMsg, true);
  view.setUint32(16, 0, true);
  message[headerBytes] = 0;
  message.set(body, headerBytes + 1);
  return message;
}

/**
 * Collects a socket's chunks into whole messages: each call answers the
 * messages the chunk completed, in order. Throws when a message announces a
 * length below the smallest OP_MSG or above `maxBytes`.
 */
export function messageFramer(
  maxBytes: number = replyBytesMax
): (chunk: Uint8Array) => Uint8Array[] {
  let pending = new Uint8Array(0);
  return (chunk) => {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    const messages: Uint8Array[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(
        joined.buffer,
        joined.byteOffset + at
      ).getInt32(0, true);
      if (length < messageBytesMin || length > maxBytes) {
        throw new RangeError(
          `a message of ${length} bytes is outside ${messageBytesMin} to ${maxBytes}`
        );
      }
      if (joined.length - at < length) {
        break;
      }
      messages.push(joined.slice(at, at + length));
      at += length;
    }
    pending = joined.slice(at);
    return messages;
  };
}

/**
 * The body of a reply to the request `requestId`: an OP_MSG that answers it,
 * with no flag the client did not ask for and exactly one body section.
 */
export function decodeReply(
  message: Uint8Array,
  requestId: number
): ExtendedDocument {
  const view = new DataView(message.buffer, message.byteOffset, message.length);
  if (
    message.length < messageBytesMin ||
    view.getInt32(0, true) !== message.length
  ) {
    throw new RangeError("a reply's length disagrees with its bytes");
  }
  if (view.getInt32(12, true) !== opMsg) {
    throw new RangeError("a reply that is not an OP_MSG");
  }
  if (view.getInt32(8, true) !== requestId) {
    throw new RangeError("a reply to another request");
  }
  const flags = view.getUint32(16, true);
  // The client never sets exhaustAllowed, so a server that says more replies follow is not one it speaks with.
  if ((flags & requiredBits & ~checksumPresent) !== 0) {
    throw new RangeError(
      `a reply with flags the client did not ask for: ${flags}`
    );
  }
  // The checksum is optional to verify, and TCP and TLS already guard the bytes.
  const end = flags & checksumPresent ? message.length - 4 : message.length;
  if (message[headerBytes] !== 0) {
    throw new RangeError("a reply whose section is not a body");
  }
  return decodeDocument(message.subarray(headerBytes + 1, end));
}
