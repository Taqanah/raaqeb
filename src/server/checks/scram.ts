/**
 * SCRAM (RFC 5802, and RFC 7677 for SHA-256) as MongoDB signs in with it
 * (the authentication specification): SHA-256 prepares the password with
 * SASLprep (RFC 4013), SHA-1 replaces it with MongoDB's MD5 digest of the user
 * and password, and the user name is never prepared. The client refuses a
 * server nonce that does not extend its own, fewer than 4096 iterations, and
 * a server signature that does not prove the server knows the password.
 */
// biome-ignore-all lint/suspicious/noBitwiseOperators: the client proof is the client key XOR its signature, by RFC 5802

export type ScramMechanism = "SCRAM-SHA-1" | "SCRAM-SHA-256";

/** The fewest iterations the client accepts, against a downgrade by whoever sits between. */
export const iterationsMin = 4096;

/** The most iterations the client spends, about 55 ms of PBKDF2; MongoDB's defaults are 15,000 for SHA-256 and 10,000 for SHA-1. A server, or whoever sits on a plain connection, could otherwise ask for billions, which no timeout can cancel. */
export const iterationsMax = 600_000;

/** One sign-in, the client's side. */
export interface ScramConversation {
  /** The client-final-message that answers the server-first-message. */
  readonly final: (serverFirst: string) => Promise<string>;
  /** The client-first-message. */
  readonly first: string;
  /** Accepts the server-final-message only when its signature is the one the password gives. */
  readonly verify: (serverFinal: string) => void;
}

/** A sign-in the server refused or the client could not trust; `code` names which. */
export class ScramError extends Error {
  override readonly name = "ScramError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const hashes = {
  "SCRAM-SHA-1": { bits: 160, hasher: "sha1", webCrypto: "SHA-1" },
  "SCRAM-SHA-256": { bits: 256, hasher: "sha256", webCrypto: "SHA-256" },
} as const;

const digits = /^\d+$/;
const encoder = new TextEncoder();

/** A SCRAM message's attributes by their letter; a value keeps every `=` after the first. */
function attributes(message: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of message.split(",")) {
    if (part[1] === "=") {
      fields.set(part[0] ?? "", part.slice(2));
    }
  }
  return fields;
}

function refuse(code: string, message: string): never {
  throw new ScramError(code, message);
}

/** The server's own `e=` error, when the message is one. */
function serverError(fields: Map<string, string>): void {
  const error = fields.get("e");
  if (error !== undefined) {
    refuse(
      "ERR_MONGODB_SASL_SERVER_ERROR",
      `the server ended the sign-in: ${error}`
    );
  }
}

function base64Of(text: string): Uint8Array {
  try {
    return Uint8Array.fromBase64(text);
  } catch {
    return refuse(
      "ERR_MONGODB_SASL_INVALID_MESSAGE",
      "base64 that does not decode"
    );
  }
}

/** Starts a conversation for the user and password with the client's nonce. */
export function scramConversation(
  mechanism: ScramMechanism,
  user: string,
  password: string,
  nonce: string
): ScramConversation {
  const hash = hashes[mechanism];
  const hmac = (key: Uint8Array, data: Uint8Array | string) =>
    new Uint8Array(
      new Bun.CryptoHasher(hash.hasher, key).update(data).digest()
    );
  const bareFirst = `n=${user.replaceAll("=", "=3D").replaceAll(",", "=2C")},r=${nonce}`;
  let serverSignature: Uint8Array | undefined;
  return {
    final: async (serverFirst) => {
      const fields = attributes(serverFirst);
      serverError(fields);
      const combined = fields.get("r");
      const salt = fields.get("s");
      const count = fields.get("i");
      if (combined === undefined || salt === undefined || count === undefined) {
        refuse(
          "ERR_MONGODB_SASL_INVALID_MESSAGE",
          "the server's first message lacks r, s or i"
        );
      }
      if (!combined.startsWith(nonce) || combined.length <= nonce.length) {
        refuse(
          "ERR_MONGODB_SASL_NONCE_MISMATCH",
          "the server's nonce does not extend the client's"
        );
      }
      const iterations = digits.test(count) ? Number(count) : 0;
      if (iterations < iterationsMin) {
        refuse(
          "ERR_MONGODB_SASL_ITERATIONS_TOO_FEW",
          `the server asks for ${count} iterations, below ${iterationsMin}`
        );
      }
      if (iterations > iterationsMax) {
        refuse(
          "ERR_MONGODB_SASL_ITERATIONS_TOO_MANY",
          `the server asks for ${count} iterations, above ${iterationsMax}`
        );
      }
      // SHA-1 signs in with MongoDB's digest of the user and password, SHA-256 with the password SASLprep prepares.
      const secret =
        mechanism === "SCRAM-SHA-256"
          ? saslPrep(password)
          : new Bun.CryptoHasher("md5")
              .update(`${user}:mongo:${password}`)
              .digest("hex");
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        "PBKDF2",
        false,
        ["deriveBits"]
      );
      const salted = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            hash: hash.webCrypto,
            iterations,
            name: "PBKDF2",
            salt: new Uint8Array(base64Of(salt)),
          },
          key,
          hash.bits
        )
      );
      const clientKey = hmac(salted, "Client Key");
      const storedKey = new Uint8Array(
        new Bun.CryptoHasher(hash.hasher).update(clientKey).digest()
      );
      const withoutProof = `c=biws,r=${combined}`;
      const authMessage = `${bareFirst},${serverFirst},${withoutProof}`;
      const clientSignature = hmac(storedKey, authMessage);
      const proof = clientKey.map(
        (byte, index) => byte ^ (clientSignature[index] ?? 0)
      );
      serverSignature = hmac(hmac(salted, "Server Key"), authMessage);
      return `${withoutProof},p=${proof.toBase64()}`;
    },
    first: `n,,${bareFirst}`,
    verify: (serverFinal) => {
      const fields = attributes(serverFinal);
      serverError(fields);
      const signature = fields.get("v");
      if (signature === undefined || serverSignature === undefined) {
        refuse(
          "ERR_MONGODB_SASL_INVALID_MESSAGE",
          "the server's final message has no signature"
        );
      }
      const given = base64Of(signature);
      if (
        given.length !== serverSignature.length ||
        !crypto.timingSafeEqual(given, serverSignature)
      ) {
        refuse(
          "ERR_MONGODB_SASL_SIGNATURE_MISMATCH",
          "the server's signature is not the one the password gives"
        );
      }
    },
  };
}

/** A fresh client nonce: 24 random bytes in base64. */
export function clientNonce(): string {
  return crypto.getRandomValues(new Uint8Array(24)).toBase64();
}

/** Prepares a password by SASLprep (RFC 4013) as a query string: unassigned code points pass. Throws a `ScramError` on a prohibited character or a bidirectional string RFC 3454 refuses. */
export function saslPrep(text: string): string {
  const mapped = [...text]
    .filter((character) => !within(ranges.nothing, character))
    .map((character) => (within(ranges.space, character) ? " " : character))
    .join("")
    .normalize("NFKC");
  const characters = [...mapped];
  const prohibited = (reason: string) =>
    refuse("ERR_MONGODB_SASLPREP_PROHIBITED", `the password holds ${reason}`);
  if (characters.some((character) => within(ranges.prohibited, character))) {
    prohibited("a character SASLprep prohibits");
  }
  if (characters.some((character) => within(ranges.randal, character))) {
    // RFC 3454 section 6: a right-to-left string holds no left-to-right letter, and starts and ends right to left.
    if (characters.some((character) => within(ranges.lcat, character))) {
      prohibited("right-to-left and left-to-right letters together");
    }
    if (
      !(
        within(ranges.randal, characters[0] ?? "") &&
        within(ranges.randal, characters.at(-1) ?? "")
      )
    ) {
      prohibited(
        "a right-to-left string that does not start and end right to left"
      );
    }
  }
  return mapped;
}

/** Whether a character's code point lies in one of the ranges. */
function within(table: Uint32Array, character: string): boolean {
  const point = character.codePointAt(0) ?? -1;
  for (let index = 0; index < table.length; index += 2) {
    if (point >= (table[index] ?? 0) && point <= (table[index + 1] ?? 0)) {
      return true;
    }
  }
  return false;
}

/** Each table as start and end pairs. */
function rangesOf(text: string): Uint32Array {
  return Uint32Array.from(
    text.split(" ").flatMap((range) => {
      const [start = "0", end = start] = range.split("-");
      return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
    })
  );
}

/**
 * RFC 3454's tables that SASLprep (RFC 4013) reads, as code point ranges in
 * hex, read once from RFC 3454's own text: the spaces mapped to a space
 * (C.1.2), the characters mapped to nothing (B.1), every prohibited table
 * (C.1.2 to C.9) merged, and the bidirectional categories RandALCat (D.1)
 * and LCat (D.2).
 */
const tables = {
  lcat:
    "41-5a 61-7a aa b5 ba c0-d6 d8-f6 f8-220 222-233 250-2ad 2b0-2b8 " +
    "2bb-2c1 2d0-2d1 2e0-2e4 2ee 37a 386 388-38a 38c 38e-3a1 3a3-3ce " +
    "3d0-3f5 400-482 48a-4ce 4d0-4f5 4f8-4f9 500-50f 531-556 559-55f " +
    "561-587 589 903 905-939 93d-940 949-94c 950 958-961 964-970 982-983 " +
    "985-98c 98f-990 993-9a8 9aa-9b0 9b2 9b6-9b9 9be-9c0 9c7-9c8 9cb-9cc " +
    "9d7 9dc-9dd 9df-9e1 9e6-9f1 9f4-9fa a05-a0a a0f-a10 a13-a28 a2a-a30 " +
    "a32-a33 a35-a36 a38-a39 a3e-a40 a59-a5c a5e a66-a6f a72-a74 a83 " +
    "a85-a8b a8d a8f-a91 a93-aa8 aaa-ab0 ab2-ab3 ab5-ab9 abd-ac0 ac9 " +
    "acb-acc ad0 ae0 ae6-aef b02-b03 b05-b0c b0f-b10 b13-b28 b2a-b30 " +
    "b32-b33 b36-b39 b3d-b3e b40 b47-b48 b4b-b4c b57 b5c-b5d b5f-b61 " +
    "b66-b70 b83 b85-b8a b8e-b90 b92-b95 b99-b9a b9c b9e-b9f ba3-ba4 " +
    "ba8-baa bae-bb5 bb7-bb9 bbe-bbf bc1-bc2 bc6-bc8 bca-bcc bd7 be7-bf2 " +
    "c01-c03 c05-c0c c0e-c10 c12-c28 c2a-c33 c35-c39 c41-c44 c60-c61 " +
    "c66-c6f c82-c83 c85-c8c c8e-c90 c92-ca8 caa-cb3 cb5-cb9 cbe cc0-cc4 " +
    "cc7-cc8 cca-ccb cd5-cd6 cde ce0-ce1 ce6-cef d02-d03 d05-d0c d0e-d10 " +
    "d12-d28 d2a-d39 d3e-d40 d46-d48 d4a-d4c d57 d60-d61 d66-d6f d82-d83 " +
    "d85-d96 d9a-db1 db3-dbb dbd dc0-dc6 dcf-dd1 dd8-ddf df2-df4 e01-e30 " +
    "e32-e33 e40-e46 e4f-e5b e81-e82 e84 e87-e88 e8a e8d e94-e97 e99-e9f " +
    "ea1-ea3 ea5 ea7 eaa-eab ead-eb0 eb2-eb3 ebd ec0-ec4 ec6 ed0-ed9 " +
    "edc-edd f00-f17 f1a-f34 f36 f38 f3e-f47 f49-f6a f7f f85 f88-f8b " +
    "fbe-fc5 fc7-fcc fcf 1000-1021 1023-1027 1029-102a 102c 1031 1038 " +
    "1040-1057 10a0-10c5 10d0-10f8 10fb 1100-1159 115f-11a2 11a8-11f9 " +
    "1200-1206 1208-1246 1248 124a-124d 1250-1256 1258 125a-125d 1260-1286 " +
    "1288 128a-128d 1290-12ae 12b0 12b2-12b5 12b8-12be 12c0 12c2-12c5 " +
    "12c8-12ce 12d0-12d6 12d8-12ee 12f0-130e 1310 1312-1315 1318-131e " +
    "1320-1346 1348-135a 1361-137c 13a0-13f4 1401-1676 1681-169a 16a0-16f0 " +
    "1700-170c 170e-1711 1720-1731 1735-1736 1740-1751 1760-176c 176e-1770 " +
    "1780-17b6 17be-17c5 17c7-17c8 17d4-17da 17dc 17e0-17e9 1810-1819 " +
    "1820-1877 1880-18a8 1e00-1e9b 1ea0-1ef9 1f00-1f15 1f18-1f1d 1f20-1f45 " +
    "1f48-1f4d 1f50-1f57 1f59 1f5b 1f5d 1f5f-1f7d 1f80-1fb4 1fb6-1fbc 1fbe " +
    "1fc2-1fc4 1fc6-1fcc 1fd0-1fd3 1fd6-1fdb 1fe0-1fec 1ff2-1ff4 1ff6-1ffc " +
    "200e 2071 207f 2102 2107 210a-2113 2115 2119-211d 2124 2126 2128 " +
    "212a-212d 212f-2131 2133-2139 213d-213f 2145-2149 2160-2183 2336-237a " +
    "2395 249c-24e9 3005-3007 3021-3029 3031-3035 3038-303c 3041-3096 " +
    "309d-309f 30a1-30fa 30fc-30ff 3105-312c 3131-318e 3190-31b7 31f0-321c " +
    "3220-3243 3260-327b 327f-32b0 32c0-32cb 32d0-32fe 3300-3376 337b-33dd " +
    "33e0-33fe 3400-4db5 4e00-9fa5 a000-a48c ac00-d7a3 d800-fa2d fa30-fa6a " +
    "fb00-fb06 fb13-fb17 ff21-ff3a ff41-ff5a ff66-ffbe ffc2-ffc7 ffca-ffcf " +
    "ffd2-ffd7 ffda-ffdc 10300-1031e 10320-10323 10330-1034a 10400-10425 " +
    "10428-1044d 1d000-1d0f5 1d100-1d126 1d12a-1d166 1d16a-1d172 " +
    "1d183-1d184 1d18c-1d1a9 1d1ae-1d1dd 1d400-1d454 1d456-1d49c " +
    "1d49e-1d49f 1d4a2 1d4a5-1d4a6 1d4a9-1d4ac 1d4ae-1d4b9 1d4bb " +
    "1d4bd-1d4c0 1d4c2-1d4c3 1d4c5-1d505 1d507-1d50a 1d50d-1d514 " +
    "1d516-1d51c 1d51e-1d539 1d53b-1d53e 1d540-1d544 1d546 1d54a-1d550 " +
    "1d552-1d6a3 1d6a8-1d7c9 20000-2a6d6 2f800-2fa1d f0000-ffffd " +
    "100000-10fffd",
  nothing: "ad 34f 1806 180b-180d 200b-200d 2060 fe00-fe0f feff",
  prohibited:
    "0-1f 7f-a0 340-341 6dd 70f 1680 180e 2000-200f 2028-202f 205f-2063 " +
    "206a-206f 2ff0-2ffb 3000 d800-f8ff fdd0-fdef feff fff9-ffff " +
    "1d173-1d17a 1fffe-1ffff 2fffe-2ffff 3fffe-3ffff 4fffe-4ffff " +
    "5fffe-5ffff 6fffe-6ffff 7fffe-7ffff 8fffe-8ffff 9fffe-9ffff " +
    "afffe-affff bfffe-bffff cfffe-cffff dfffe-dffff e0001 e0020-e007f " +
    "efffe-10ffff",
  randal:
    "5be 5c0 5c3 5d0-5ea 5f0-5f4 61b 61f 621-63a 640-64a 66d-66f 671-6d5 " +
    "6dd 6e5-6e6 6fa-6fe 700-70d 710 712-72c 780-7a5 7b1 200f fb1d " +
    "fb1f-fb28 fb2a-fb36 fb38-fb3c fb3e fb40-fb41 fb43-fb44 fb46-fbb1 " +
    "fbd3-fd3d fd50-fd8f fd92-fdc7 fdf0-fdfc fe70-fe74 fe76-fefc",
  space: "a0 1680 2000-200b 202f 205f 3000",
};

const ranges = {
  lcat: rangesOf(tables.lcat),
  nothing: rangesOf(tables.nothing),
  prohibited: rangesOf(tables.prohibited),
  randal: rangesOf(tables.randal),
  space: rangesOf(tables.space),
};
