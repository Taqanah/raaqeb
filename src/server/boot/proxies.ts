/**
 * Client addresses behind the trusted proxies: the one
 * place that decides which address a request comes from. The Bun.serve entry
 * asks with the socket peer and the forwarded chain, then writes the answer
 * into one header that Better Auth's rate limit reads (`clientAddressHeader`),
 * overwriting anything a client sent. Better Auth would otherwise believe a
 * bare `x-forwarded-for`, and it drops an invalid trusted-proxy entry with a
 * warning that prints it; here an invalid entry refuses the boot by variable
 * name, and the save of the general page by a reason code.
 */

/** The header the entry sets on every request with the resolved client address. */
export const clientAddressHeader = "x-raaqeb-client-address";

/** The header the entry writes with the origin the client used, resolved behind the trusted proxies; the onboarding account screen pre-fills the public address from it until the browser's own origin replaces it. */
export const requestOriginHeader = "x-raaqeb-request-origin";

/** The socket peer a request came from, and whether it is a trusted proxy. */
export interface Peer {
  readonly address: string;
  readonly trusted: boolean;
}

const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const prefixDigits = /^\d{1,3}$/;
const hextetDigits = /^[0-9a-fA-F]{1,4}$/;

/** An address as 16 bytes; IPv4 is mapped into the IPv6 space so one comparison serves both. */
function addressBytes(text: string): Uint8Array | undefined {
  const four = ipv4.exec(text);
  if (four) {
    const octets = four.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) {
      return;
    }
    return Uint8Array.from([...new Array(10).fill(0), 255, 255, ...octets]);
  }
  return ipv6Bytes(text);
}

function ipv6Bytes(text: string): Uint8Array | undefined {
  if (!text.includes(":") || text.includes(" ")) {
    return;
  }
  let body = text;
  // A trailing dotted quad (::ffff:10.0.0.1) becomes its two hextets.
  const lastColon = body.lastIndexOf(":");
  const tail = body.slice(lastColon + 1);
  if (ipv4.test(tail)) {
    const mapped = addressBytes(tail);
    if (!mapped) {
      return;
    }
    const high = (mapped[12] ?? 0) * 256 + (mapped[13] ?? 0);
    const low = (mapped[14] ?? 0) * 256 + (mapped[15] ?? 0);
    body = `${body.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = body.split("::");
  if (halves.length > 2) {
    return;
  }
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest =
    halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return;
  }
  const hextets = [...head, ...new Array(missing).fill("0"), ...rest];
  const bytes = new Uint8Array(16);
  for (const [index, hextet] of hextets.entries()) {
    if (!hextetDigits.test(hextet)) {
      return;
    }
    const value = Number.parseInt(hextet, 16);
    bytes[index * 2] = Math.floor(value / 256);
    bytes[index * 2 + 1] = value % 256;
  }
  return bytes;
}

interface Range {
  readonly bytes: Uint8Array;
  /** Prefix length in the 128-bit space. */
  readonly prefix: number;
}

function parseRange(entry: string): Range | undefined {
  const [address, prefixText, ...rest] = entry.split("/");
  if (address === undefined || rest.length > 0) {
    return;
  }
  const bytes = addressBytes(address);
  if (!bytes) {
    return;
  }
  const four = ipv4.test(address);
  const full = four ? 32 : 128;
  if (prefixText === undefined) {
    return { bytes, prefix: 128 };
  }
  if (!prefixDigits.test(prefixText) || Number(prefixText) > full) {
    return;
  }
  return { bytes, prefix: Number(prefixText) + (four ? 96 : 0) };
}

/** The bit at a position in a 16-byte address, most significant first. */
function bitAt(bytes: Uint8Array, position: number): number {
  const byte = bytes[Math.floor(position / 8)] ?? 0;
  return Math.floor(byte / 2 ** (7 - (position % 8))) % 2;
}

function inRange(bytes: Uint8Array, range: Range): boolean {
  for (let bit = 0; bit < range.prefix; bit += 1) {
    if (bitAt(bytes, bit) !== bitAt(range.bytes, bit)) {
      return false;
    }
  }
  return true;
}

/** The network a client address counts as: an IPv4 address alone, written as IPv4 or as IPv4 in IPv6, an IPv6 address's /64, since one host holds a whole /64; text that is no address is itself. */
export function clientNetwork(address: string): string {
  if (ipv4.test(address)) {
    return address;
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return address;
  }
  // An IPv4 address written in IPv6 (::ffff:a.b.c.d) is that IPv4 address.
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255
  ) {
    return [...bytes.slice(12)].join(".");
  }
  return `${bytes.slice(0, 8).toHex()}/64`;
}

/** True for `10.0.0.1`, `10.0.0.0/8`, `::1` or `fd00::/8`. */
export function isProxyEntry(entry: string): boolean {
  return parseRange(entry) !== undefined;
}

/** Whether an address sits in one of the ranges (`10.0.0.0/8`, `::1`); an entry that is not a range holds nothing. The trusted proxies and the webhook destinations a visitor may not name both read it. */
export function inRanges(
  entries: readonly string[]
): (address: string) => boolean {
  const ranges = entries
    .map(parseRange)
    .filter((range): range is Range => range !== undefined);
  return (address) => {
    const bytes = addressBytes(address);
    return bytes !== undefined && ranges.some((range) => inRange(bytes, range));
  };
}

/**
 * The client's address: the socket peer, unless the peer is a trusted proxy,
 * in which case the forwarded chain is walked from its end, skipping trusted
 * hops, to the first address that is not one. A chain of only trusted hops,
 * or none, answers the peer. Nothing when the peer is unknown (a unix socket).
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | null,
  trustedProxies: readonly string[]
): string | undefined {
  if (peer === undefined) {
    return;
  }
  const trusted = inRanges(trustedProxies);
  if (!trusted(peer)) {
    return peer;
  }
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const hop = chain[index] ?? "";
    if (addressBytes(hop) === undefined) {
      // A forged or malformed hop: the walk ends at the peer, which is real.
      return peer;
    }
    if (!trusted(hop)) {
      return hop;
    }
  }
  return peer;
}

/**
 * The origin the client used: the request URL's own scheme and host, unless
 * the peer is a trusted proxy, in which case `X-Forwarded-Proto` and
 * `X-Forwarded-Host` (first value each) replace them when present.
 * Nothing when the peer is unknown or a forwarded value is not a scheme or a
 * host.
 */
export function requestOrigin(
  requestUrl: string,
  peer: string | undefined,
  forwardedProto: string | null,
  forwardedHost: string | null,
  trustedProxies: readonly string[]
): string | undefined {
  if (peer === undefined) {
    return;
  }
  const own = new URL(requestUrl);
  if (!inRanges(trustedProxies)(peer)) {
    return own.origin;
  }
  const proto = firstValue(forwardedProto) ?? own.protocol.slice(0, -1);
  const host = firstValue(forwardedHost) ?? own.host;
  if (proto !== "http" && proto !== "https") {
    return;
  }
  let forwarded: URL;
  try {
    forwarded = new URL(`${proto}://${host}`);
  } catch {
    return;
  }
  // A host the parser had to repair (a path, a query, a credential) is not a host; a default port it drops is.
  const repaired =
    forwarded.pathname !== "/" ||
    forwarded.search !== "" ||
    forwarded.hash !== "" ||
    forwarded.username !== "" ||
    forwarded.hostname === "";
  return repaired ? undefined : forwarded.origin;
}

/** The first entry of a comma-separated header value, trimmed; nothing for a missing or blank header. */
function firstValue(header: string | null): string | undefined {
  const first = header?.split(",")[0]?.trim();
  return first ? first : undefined;
}
