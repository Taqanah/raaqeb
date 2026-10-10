/**
 * The install key (CONTEXT.md): the secret that encrypts every
 * credential at rest with AES-256-GCM through WebCrypto. Encoded as 32 random
 * bytes in base64url; a ciphertext is `1.` followed by the base64url of the
 * 12-byte nonce, the ciphertext and the 16-byte tag.
 */

export interface InstallKey {
  readonly cryptoKey: CryptoKey;
}

const keyLength = 32;
const nonceLength = 12;
const tagLength = 16;
const version = "1.";
/** 32 bytes in base64url without padding is exactly 43 characters of this alphabet. */
const encodedKey = /^[A-Za-z0-9_-]{43}$/;

function toBase64url(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.fromBase64(text, { alphabet: "base64url" });
  } catch {
    // Not base64url: the caller treats it as no bytes.
  }
}

/** A new key, encoded. */
export function generateInstallKey(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(keyLength)));
}

/** The key behind an encoded value, or nothing when it is not 32 bytes in base64url. */
export async function importInstallKey(
  encoded: string
): Promise<InstallKey | undefined> {
  if (!encodedKey.test(encoded)) {
    return;
  }
  const bytes = fromBase64url(encoded);
  if (bytes?.length !== keyLength) {
    return;
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bytes,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  return { cryptoKey };
}

/** Encrypts a credential; each call draws a fresh nonce. */
export async function encrypt(
  key: InstallKey,
  plaintext: string
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(nonceLength));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { iv: nonce, name: "AES-GCM" },
      key.cryptoKey,
      new TextEncoder().encode(plaintext)
    )
  );
  const bytes = new Uint8Array(nonce.length + sealed.length);
  bytes.set(nonce);
  bytes.set(sealed, nonce.length);
  return `${version}${toBase64url(bytes)}`;
}

/** The credential behind a ciphertext, or nothing when the layout or the key is wrong. */
export async function decrypt(
  key: InstallKey,
  ciphertext: string
): Promise<string | undefined> {
  if (!ciphertext.startsWith(version)) {
    return;
  }
  const bytes = fromBase64url(ciphertext.slice(version.length));
  if (!bytes || bytes.length < nonceLength + tagLength) {
    return;
  }
  try {
    const opened = await crypto.subtle.decrypt(
      { iv: bytes.subarray(0, nonceLength), name: "AES-GCM" },
      key.cryptoKey,
      bytes.subarray(nonceLength)
    );
    return new TextDecoder().decode(opened);
  } catch {
    // A wrong key or a tampered ciphertext fails the tag check: no credential.
  }
}
