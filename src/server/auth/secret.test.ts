import { afterEach, describe, expect, test } from "bun:test";
import { scratchDatabase } from "@/server/storage/fixture.ts";
import { defineSetting } from "@/server/storage/settings.ts";
import { openStorage, type Storage } from "@/server/storage/storage.ts";
import {
  betterAuthSecrets,
  generateSecrets,
  parseSecrets,
  resolveSecrets,
  versionedSecretsSchema,
} from "./secret.ts";

const versionOne = /^1:[A-Za-z0-9_-]{43}$/;

let open: { storage: Storage; cleanup: () => Promise<void> } | undefined;

async function storage(): Promise<Storage> {
  const scratch = await scratchDatabase();
  const opened = await openStorage(scratch.location);
  if (!opened.ok) {
    throw new Error(opened.message);
  }
  open = { cleanup: scratch.cleanup, storage: opened.storage };
  return opened.storage;
}

afterEach(async () => {
  if (open) {
    await open.storage.close();
    await open.cleanup();
    open = undefined;
  }
});

describe("Better Auth's secret", () => {
  test("is a setting keyed better_auth_secrets in the versioned form", () => {
    expect(betterAuthSecrets.key).toBe("better_auth_secrets");
    expect(versionedSecretsSchema.safeParse("1:abc").success).toBe(true);
    expect(versionedSecretsSchema.safeParse("2:def,1:abc").success).toBe(true);
    expect(versionedSecretsSchema.safeParse("abc").success).toBe(false);
    expect(versionedSecretsSchema.safeParse("1:").success).toBe(false);
    expect(versionedSecretsSchema.safeParse("x:abc").success).toBe(false);
  });

  test("a generated secret is version 1 over 32 random bytes, different every time", () => {
    const a = generateSecrets();
    expect(a).toMatch(versionOne);
    expect(generateSecrets()).not.toBe(a);
  });

  test("the versioned text parses into entries with the first one current", () => {
    expect(parseSecrets("2:def,1:abc")).toEqual([
      { value: "def", version: 2 },
      { value: "abc", version: 1 },
    ]);
  });

  test("is generated into the settings table the first time and reused after", async () => {
    const store = await storage();
    const first = await resolveSecrets(store, undefined);
    expect(first.generated).toBe(true);
    expect(first.overridden).toBe(false);
    expect(first.secrets).toMatch(versionOne);
    expect(await store.settings.get(betterAuthSecrets)).toBe(first.secrets);
    const second = await resolveSecrets(store, undefined);
    expect(second).toEqual({
      generated: false,
      overridden: false,
      secrets: first.secrets,
    });
  });

  test("BETTER_AUTH_SECRETS wins, is never written, and leaves a stored secret untouched", async () => {
    const store = await storage();
    await store.settings.set(
      betterAuthSecrets,
      "1:stored-stored-stored-stored-stored-s"
    );
    const resolved = await resolveSecrets(
      store,
      "2:env-env-env-env-env-env-env-env-env-env,1:old"
    );
    expect(resolved).toEqual({
      generated: false,
      overridden: true,
      secrets: "2:env-env-env-env-env-env-env-env-env-env,1:old",
    });
    expect(await store.settings.get(betterAuthSecrets)).toBe(
      "1:stored-stored-stored-stored-stored-s"
    );
  });

  test("a database that cannot answer is an error, never a new secret that would sign everyone out", async () => {
    const store = await storage();
    await store.settings.set(
      betterAuthSecrets,
      "1:stored-stored-stored-stored-stored-s"
    );
    await store.close();
    await expect(resolveSecrets(store, undefined)).rejects.toBeDefined();
  });

  test("a stored value outside the versioned form is replaced by a new secret", async () => {
    const store = await storage();
    const anything = defineSetting<string>(betterAuthSecrets.key, {
      safeParse: (value: unknown) => ({ data: String(value), success: true }),
    } as never);
    await store.settings.set(anything, "not versioned");
    const resolved = await resolveSecrets(store, undefined);
    expect(resolved.generated).toBe(true);
    expect(resolved.secrets).toMatch(versionOne);
    expect(await store.settings.get(betterAuthSecrets)).toBe(resolved.secrets);
  });
});
