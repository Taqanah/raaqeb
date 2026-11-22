import { describe, expect, test } from "bun:test";
// Better Auth's default hasher, to prove its rows are refused rather than crashed on.
import { hashPassword as betterAuthHash } from "better-auth/crypto";
import { hashPassword, verifyPassword } from "./password.ts";

const password = "correct horse battery staple";
const scryptShape = /^[0-9a-f]+:[0-9a-f]+$/;
const phc = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

// The five Argon2id configurations OWASP lists as equal in defence.
const owaspArgon2id = [
  { m: 47_104, p: 1, t: 1 },
  { m: 19_456, p: 1, t: 2 },
  { m: 12_288, p: 1, t: 3 },
  { m: 9216, p: 1, t: 4 },
  { m: 7168, p: 1, t: 5 },
];

describe("the operator's password hash", () => {
  test("verifies the password it was made from", async () => {
    const hash = await hashPassword(password);
    expect(await verifyPassword({ hash, password })).toBe(true);
  });

  test("refuses a different password", async () => {
    const hash = await hashPassword(password);
    expect(await verifyPassword({ hash, password: "wrong" })).toBe(false);
  });

  test("salts every hash on its own", async () => {
    const [a, b] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);
    expect(a).not.toBe(b);
  });

  test("is Argon2id in PHC form with one of OWASP's configurations, under 19 MiB for the floor", async () => {
    const match = phc.exec(await hashPassword(password));
    expect(match).not.toBeNull();
    const m = Number(match?.[1]);
    const t = Number(match?.[2]);
    const p = Number(match?.[3]);
    expect(owaspArgon2id).toContainEqual({ m, p, t });
    expect(m).toBeLessThanOrEqual(19_456);
  });

  test("normalises the password to NFKC, so the same typed word verifies whatever the keyboard composed", async () => {
    const composed = "passéword";
    const decomposed = "passéword";
    expect(composed).not.toBe(decomposed);
    expect(
      await verifyPassword({
        hash: await hashPassword(composed),
        password: decomposed,
      })
    ).toBe(true);
    expect(
      await verifyPassword({
        hash: await hashPassword(decomposed),
        password: composed,
      })
    ).toBe(true);
  });
});

describe("a hash Bun cannot parse is a failed sign-in, not a crash", () => {
  test("Better Auth's default scrypt hash is refused", async () => {
    const legacy = await betterAuthHash(password);
    expect(legacy).toMatch(scryptShape);
    expect(await verifyPassword({ hash: legacy, password })).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["no separator", "deadbeef"],
    ["unknown algorithm", "$scrypt$N=8192,r=8,p=10$abcd$beef"],
    ["corrupt argon2 payload", "$argon2id$v=19$m=12288,t=3,p=1$abc$def"],
    ["bcrypt with a bad payload", "$2b$10$abcdefghijklmnopqrstuv"],
  ])("answers false for %s", async (_label, hash) => {
    expect(await verifyPassword({ hash, password })).toBe(false);
  });
});

// Each hash holds its memory cost while it runs, and Bun runs as many at once as it sees cores, so a burst of sign-ins on a many-core host with a 240 MB limit was killed.
describe("one hash at a time", () => {
  const slowHash = Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 12_288,
    timeCost: 40,
  });
  const fastHash = Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 64,
    timeCost: 1,
  });

  /** The order two password calls settle in when both start at once. */
  async function settled(
    first: () => Promise<unknown>,
    second: () => Promise<unknown>
  ): Promise<string[]> {
    const order: string[] = [];
    await Promise.all([
      first().then(() => order.push("first")),
      second().then(() => order.push("second")),
    ]);
    return order;
  }

  test("a sign-in that starts during a slow one waits for it, however quick its own hash", async () => {
    const slow = await slowHash;
    const fast = await fastHash;
    expect(
      await settled(
        () => verifyPassword({ hash: slow, password }),
        () => verifyPassword({ hash: fast, password })
      )
    ).toEqual(["first", "second"]);
  });

  test("a new password is hashed after the sign-in already running", async () => {
    const slow = await slowHash;
    expect(
      await settled(
        () => verifyPassword({ hash: slow, password }),
        () => hashPassword(password)
      )
    ).toEqual(["first", "second"]);
  });

  test("a hash Bun cannot parse does not hold up the next sign-in", async () => {
    const fast = await fastHash;
    expect(await verifyPassword({ hash: "deadbeef", password })).toBe(false);
    expect(await verifyPassword({ hash: fast, password })).toBe(true);
  });
});
