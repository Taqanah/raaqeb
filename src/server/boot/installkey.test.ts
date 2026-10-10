import { describe, expect, test } from "bun:test";
import {
  decrypt,
  encrypt,
  generateInstallKey,
  type InstallKey,
  importInstallKey,
} from "./installkey.ts";

const base64urlKey = /^[A-Za-z0-9_-]{43}$/;
const ciphertextLayout = /^1\.[A-Za-z0-9_-]+$/;

async function freshKey(): Promise<InstallKey> {
  const key = await importInstallKey(generateInstallKey());
  if (!key) {
    throw new Error("a generated install key must import");
  }
  return key;
}

function bytesOf(ciphertext: string): Uint8Array {
  return Uint8Array.fromBase64(ciphertext.slice("1.".length), {
    alphabet: "base64url",
  });
}

describe("the install key", () => {
  test("a generated key is 32 bytes in base64url without padding", () => {
    const encoded = generateInstallKey();
    expect(encoded).toMatch(base64urlKey);
    expect(
      Uint8Array.fromBase64(encoded, { alphabet: "base64url" })
    ).toHaveLength(32);
  });

  test("two generated keys differ", () => {
    expect(generateInstallKey()).not.toBe(generateInstallKey());
  });

  test.each([
    ["empty", ""],
    ["16 bytes", "AAAAAAAAAAAAAAAAAAAAAA"],
    ["33 bytes", `${"A".repeat(44)}`],
    ["not base64url", `${"A".repeat(42)}*`],
    ["standard base64 with padding", `${"A".repeat(42)}A=`],
  ])(
    "a key that is not 32 bytes in base64url does not import: %s",
    async (_, encoded) => {
      expect(await importInstallKey(encoded)).toBeUndefined();
    }
  );
});

describe("a credential at rest", () => {
  test("round-trips through the key", async () => {
    const key = await freshKey();
    const ciphertext = await encrypt(key, "postgres://raaqeb:s3cret@db/raaqeb");
    expect(await decrypt(key, ciphertext)).toBe(
      "postgres://raaqeb:s3cret@db/raaqeb"
    );
  });

  test("keeps Arabic text intact", async () => {
    const key = await freshKey();
    expect(await decrypt(key, await encrypt(key, "كلمة السر"))).toBe(
      "كلمة السر"
    );
  });

  test("an empty credential round-trips", async () => {
    const key = await freshKey();
    expect(await decrypt(key, await encrypt(key, ""))).toBe("");
  });

  test("the same credential encrypts differently each time", async () => {
    const key = await freshKey();
    expect(await encrypt(key, "token")).not.toBe(await encrypt(key, "token"));
  });

  test("the ciphertext is version 1, then nonce, ciphertext and tag in base64url", async () => {
    const key = await freshKey();
    const ciphertext = await encrypt(key, "token");
    expect(ciphertext).toMatch(ciphertextLayout);
    expect(bytesOf(ciphertext)).toHaveLength(12 + "token".length + 16);
  });

  test("the ciphertext does not contain the credential", async () => {
    const key = await freshKey();
    expect(await encrypt(key, "hunter2hunter2")).not.toContain("hunter2");
  });

  test("another key does not open it", async () => {
    const ciphertext = await encrypt(await freshKey(), "token");
    expect(await decrypt(await freshKey(), ciphertext)).toBeUndefined();
  });

  test("a tampered ciphertext does not open", async () => {
    const key = await freshKey();
    const bytes = bytesOf(await encrypt(key, "token"));
    const last = bytes.at(-1) ?? 0;
    bytes[bytes.length - 1] = (last + 1) % 256;
    const tampered = `1.${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
    expect(await decrypt(key, tampered)).toBeUndefined();
  });

  test("a ciphertext relabelled to another version does not open", async () => {
    const key = await freshKey();
    const ciphertext = await encrypt(key, "token");
    expect(
      await decrypt(key, `2.${ciphertext.slice("1.".length)}`)
    ).toBeUndefined();
    expect(await decrypt(key, ciphertext.slice("1.".length))).toBeUndefined();
  });

  test.each([
    ["no version", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["unknown version", "2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["not base64url", "1.***"],
    ["shorter than a nonce and a tag", "1.AAAA"],
    ["empty", ""],
  ])("a value that is not a ciphertext does not open: %s", async (_, value) => {
    expect(await decrypt(await freshKey(), value)).toBeUndefined();
  });
});
