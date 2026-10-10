/**
 * The synthetic target's DNS responder: one answer per query
 * over UDP, enough for the DNS monitors. A question for an A record gets
 * one address; any other question an answer with no records, which the
 * check reads as DNS failed. It imports nothing: the target's container
 * mounts the harness folder alone.
 */

/** The header's length, and the type and class codes of an A record on the internet. */
const headerBytes = 12;
const typeA = 1;
const classIn = 1;
/** Seconds a resolver may keep the answer. */
const ttl = 60;

/** The response to one DNS query: the question echoed and, for an A record, one answer; nothing for bytes that are no query. */
export function dnsAnswer(
  query: Uint8Array,
  address: string
): Uint8Array | undefined {
  let at = headerBytes;
  while (at < query.length && query[at] !== 0) {
    at += (query[at] ?? 0) + 1;
  }
  // The name's closing zero, then its type and class, two bytes each.
  const end = at + 5;
  if (end > query.length) {
    return undefined;
  }
  const type = (query[at + 1] ?? 0) * 256 + (query[at + 2] ?? 0);
  const answers = type === typeA ? 1 : 0;
  // A response, authoritative, with the query's recursion-desired flag kept.
  const header = [
    query[0] ?? 0,
    query[1] ?? 0,
    0x84 + ((query[2] ?? 0) % 2),
    0,
    0,
    1,
    0,
    answers,
    0,
    0,
    0,
    0,
  ];
  const record =
    answers === 0
      ? []
      : [
          // A pointer to the question's name at the header's end.
          0xc0,
          headerBytes,
          0,
          typeA,
          0,
          classIn,
          0,
          0,
          0,
          ttl,
          0,
          4,
          ...address.split(".").map(Number),
        ];
  return new Uint8Array([
    ...header,
    ...query.subarray(headerBytes, end),
    ...record,
  ]);
}
