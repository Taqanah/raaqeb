import { afterEach, describe, expect, test } from "bun:test";
import { authFor } from "@/server/auth/auth.ts";
import { readOperator } from "@/server/auth/session.ts";
import { readConfigFile } from "@/server/boot/datadir.ts";
import { decrypt } from "@/server/boot/installkey.ts";
import {
  type BootSettings,
  resolveBootSettings,
} from "@/server/boot/settings.ts";
import { publicAddress } from "@/server/settings/address.ts";
import { readGeneralSettings } from "@/server/settings/general.ts";
import { installLanguage } from "@/server/settings/language.ts";
import {
  fixtureBackend,
  fixtureUrl,
  runSql,
  scratchDatabase,
} from "@/server/storage/fixture.ts";
import {
  databaseOpener,
  defaultDatabaseLocation,
  openStorage,
  type Storage,
} from "@/server/storage/storage.ts";
import {
  chooseDatabase,
  createOperatorAccount,
  type OnboardingContext,
  onboardingStep,
  onboardingSteps,
  suggestedPublicAddress,
  testDatabaseUrl,
} from "./onboarding.ts";

const onPostgres = fixtureBackend() === "postgres";
/** The opener as the entry builds it, attaching nowhere: the connection test writes nothing. */
const opener = databaseOpener(() => undefined);

/** A context with no database and the entry's opener, for the connection test. */
async function testing(): Promise<OnboardingContext> {
  const { boot: settings } = await boot();
  return { boot: settings, opener, storage: undefined };
}

/** The verdict a test answered, or a throw when it refused. */
function verdictOf(
  result: Awaited<ReturnType<typeof testDatabaseUrl>>
): Extract<typeof result, { ok: true }>["verdict"] {
  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`);
  }
  return result.verdict;
}
const unreachableUrl = "postgres://u:p@127.0.0.1:1/raaqeb";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Storages close before their directories go, so the list runs from the end.
  const pending = cleanups.splice(0).toReversed();
  await pending.reduce(
    (chain, cleanup) => chain.then(cleanup),
    Promise.resolve()
  );
});

/** A data directory of its own with the boot settings resolved in it. */
async function boot(
  env: Record<string, string> = {}
): Promise<{ boot: BootSettings; dataDir: string }> {
  const dataDir = (await Bun.$`mktemp -d`.text()).trim();
  cleanups.push(async () => {
    await Bun.$`rm -rf ${dataDir}`.quiet();
  });
  const booted = await resolveBootSettings(
    {},
    { RAAQEB_DATA_DIR: dataDir, ...env }
  );
  if (!booted.ok) {
    throw new Error(booted.message);
  }
  return { boot: booted.settings, dataDir };
}

/** A context with no database open, recording what the screen attaches. */
async function fresh(env: Record<string, string> = {}): Promise<{
  context: OnboardingContext;
  dataDir: string;
  attached: () => Storage | undefined;
}> {
  const { boot: settings, dataDir } = await boot(env);
  let attached: Storage | undefined;
  cleanups.push(async () => {
    await attached?.close();
  });
  const context: OnboardingContext = {
    boot: settings,
    opener: databaseOpener((storage) => {
      attached = storage;
    }),
    storage: undefined,
  };
  return { attached: () => attached, context, dataDir };
}

/** A context over an open, empty database. */
async function opened(): Promise<{
  context: OnboardingContext;
  storage: Storage;
}> {
  const { boot: settings } = await boot();
  const scratch = await scratchDatabase();
  cleanups.push(scratch.cleanup);
  const result = await openStorage(scratch.location);
  if (!result.ok) {
    throw new Error(result.message);
  }
  cleanups.push(() => result.storage.close());
  return {
    context: {
      boot: settings,
      opener: databaseOpener(() => undefined),
      storage: result.storage,
    },
    storage: result.storage,
  };
}

/** The request headers of a form the browser sent from the origin. */
function at(origin: string): Headers {
  return new Headers({ origin });
}

const account = {
  email: "operator@example.com",
  locale: "en",
  password: "correct horse battery",
  publicAddress: "http://status.example.com",
} as const;

describe("the step an install is at", () => {
  test("is the database screen with no database open", async () => {
    expect(await onboardingStep(undefined)).toBe("database");
  });

  test("is the account screen with a database open and no operator account", async () => {
    const { storage } = await opened();
    expect(await onboardingStep(storage)).toBe("account");
  });

  test("is done once the operator account exists", async () => {
    const { context, storage } = await opened();
    await createOperatorAccount(account, context, at(account.publicAddress));
    expect(await onboardingStep(storage)).toBe("done");
  });

  test("is done when the database cannot answer: an install never presents itself as unclaimed on an outage", async () => {
    const { storage } = await opened();
    await storage.close();
    expect(await onboardingStep(storage)).toBe("done");
  });
});

describe("how many screens onboarding has", () => {
  test("three when the database is chosen on screen", () => {
    expect(onboardingSteps({ databaseUrlFromEnvironment: false })).toBe(3);
  });

  test("two when the environment names the database, which skips its screen", () => {
    expect(onboardingSteps({ databaseUrlFromEnvironment: true })).toBe(2);
  });
});

describe("the connection test on the database screen", () => {
  test("nothing listening is unreachable with the failure code, within a screen's patience", async () => {
    const started = Date.now();
    expect(
      verdictOf(await testDatabaseUrl(unreachableUrl, await testing()))
    ).toEqual({
      failure: "refused",
      kind: "unreachable",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test.each(["mysql://x", "not a url"])(
    "%p is not a Postgres URL: unreachable with the malformed code",
    async (text) => {
      expect(verdictOf(await testDatabaseUrl(text, await testing()))).toEqual({
        failure: "malformed",
        kind: "unreachable",
      });
    }
  );

  test("is refused once a database is open: the screen is behind the install", async () => {
    const { context } = await opened();
    expect(await testDatabaseUrl(unreachableUrl, context)).toEqual({
      ok: false,
      reason: "already_chosen",
    });
  });

  test("a test that throws after connecting is unreachable with the unknown code, never a throw", async () => {
    const context = await testing();
    const result = await testDatabaseUrl(unreachableUrl, {
      ...context,
      opener: {
        open: opener.open,
        test: () => Promise.reject(new Error("catalog query failed")),
      },
    });
    expect(verdictOf(result)).toEqual({
      failure: "unknown",
      kind: "unreachable",
    });
  });

  test.if(onPostgres)("an empty database is empty", async () => {
    const scratch = await scratchDatabase();
    expect(
      verdictOf(await testDatabaseUrl(fixtureUrl() ?? "", await testing()))
    ).toEqual({ kind: "empty" });
    await scratch.cleanup();
  });

  test.if(onPostgres)(
    "a Raaqeb database is Raaqeb at the version its record shows",
    async () => {
      const scratch = await scratchDatabase();
      const result = await openStorage(scratch.location);
      if (!result.ok) {
        throw new Error(result.message);
      }
      await result.storage.close();
      const verdict = verdictOf(
        await testDatabaseUrl(fixtureUrl() ?? "", await testing())
      );
      expect(verdict.kind).toBe("raaqeb");
      expect(verdict.kind === "raaqeb" && verdict.version).toBeGreaterThan(0);
    }
  );

  test.if(onPostgres)("foreign tables are counted, not named", async () => {
    const scratch = await scratchDatabase();
    await runSql(scratch.location, "CREATE TABLE theirs (id integer)");
    expect(
      verdictOf(await testDatabaseUrl(fixtureUrl() ?? "", await testing()))
    ).toEqual({ kind: "foreign", tables: 1 });
  });

  test.if(onPostgres)(
    "Raaqeb table names with no migration record are unrecorded",
    async () => {
      const scratch = await scratchDatabase();
      await runSql(scratch.location, "CREATE TABLE settings (id integer)");
      expect(
        verdictOf(await testDatabaseUrl(fixtureUrl() ?? "", await testing()))
      ).toEqual({ kind: "unrecorded" });
    }
  );
});

describe("choosing the database", () => {
  test("SQLite opens the default file in the data directory, hands it to the entry and writes no URL to config.json", async () => {
    const { attached, context, dataDir } = await fresh();
    expect(await chooseDatabase({ backend: "sqlite" }, context)).toEqual({
      next: "account",
      ok: true,
    });
    expect(await Bun.file(`${dataDir}/raaqeb.sqlite`).exists()).toBe(true);
    expect(attached()?.backend).toBe("sqlite");
    expect(await onboardingStep(attached())).toBe("account");
    const config = await readConfigFile(dataDir);
    expect(config.ok && config.config.databaseUrl).toBeUndefined();
  });

  test("two choices at once open one database; the other is refused", async () => {
    const { context } = await fresh();
    const attached: Storage[] = [];
    const counting: OnboardingContext = {
      ...context,
      opener: databaseOpener((storage) => {
        attached.push(storage);
      }),
    };
    cleanups.push(async () => {
      await Promise.all(attached.map((storage) => storage.close()));
    });
    const [first, second] = await Promise.all([
      chooseDatabase({ backend: "sqlite" }, counting),
      chooseDatabase({ backend: "sqlite" }, counting),
    ]);
    expect([first.ok, second.ok].toSorted()).toEqual([false, true]);
    expect(first.ok ? second : first).toEqual({
      ok: false,
      reason: "already_chosen",
    });
    expect(attached).toHaveLength(1);
  });

  test("adopting a database that already holds the operator account says onboarding is done", async () => {
    const { attached, context, dataDir } = await fresh();
    const earlier = await openStorage(defaultDatabaseLocation(dataDir));
    if (!earlier.ok) {
      throw new Error(earlier.message);
    }
    const made = await createOperatorAccount(
      account,
      { ...context, storage: earlier.storage },
      at(account.publicAddress)
    );
    expect(made.ok).toBe(true);
    await earlier.storage.close();
    expect(await chooseDatabase({ backend: "sqlite" }, context)).toEqual({
      next: "done",
      ok: true,
    });
    expect(await onboardingStep(attached())).toBe("done");
  });

  test("a database already open refuses a second choice and attaches nothing", async () => {
    const { context } = await opened();
    let attached = false;
    const result = await chooseDatabase(
      { backend: "sqlite" },
      {
        ...context,
        opener: databaseOpener(() => {
          attached = true;
        }),
      }
    );
    expect(result).toEqual({ ok: false, reason: "already_chosen" });
    expect(attached).toBe(false);
  });

  test("an unreachable Postgres is refused, nothing attached, config.json untouched", async () => {
    const { attached, context, dataDir } = await fresh();
    const before = await Bun.file(`${dataDir}/config.json`).text();
    // The connection test's patience is pinned above; a short window keeps this one quick.
    const quick: OnboardingContext["opener"] = {
      open: context.opener.open,
      test: (url) => context.opener.test(url, { windowMs: 100 }),
    };
    expect(
      await chooseDatabase(
        { backend: "postgres", url: unreachableUrl },
        { ...context, opener: quick }
      )
    ).toEqual({ ok: false, reason: "refused" });
    expect(attached()).toBeUndefined();
    expect(await Bun.file(`${dataDir}/config.json`).text()).toBe(before);
  });

  test.if(onPostgres)(
    "Postgres opens and migrates the database, hands it to the entry, and writes the URL encrypted with the install key",
    async () => {
      const scratch = await scratchDatabase();
      const url = fixtureUrl() ?? "";
      const { attached, context, dataDir } = await fresh();
      expect(
        await chooseDatabase({ backend: "postgres", url }, context)
      ).toEqual({ next: "account", ok: true });
      expect(attached()?.backend).toBe("postgres");
      expect(await onboardingStep(attached())).toBe("account");
      const config = await readConfigFile(dataDir);
      const stored = config.ok ? config.config.databaseUrl : undefined;
      expect(stored).toBeDefined();
      expect(stored).not.toContain(url);
      expect(await decrypt(context.boot.installKey, stored ?? "")).toBe(url);
      expect(config.ok && config.config.installKey).toBeDefined();
      await scratch.cleanup();
    }
  );

  test.if(onPostgres)(
    "the general settings name Postgres as the backend once onboarding chose it, with no restart",
    async () => {
      const scratch = await scratchDatabase();
      const { attached, context } = await fresh();
      await chooseDatabase(
        { backend: "postgres", url: fixtureUrl() ?? "" },
        context
      );
      const storage = attached();
      if (!storage) {
        throw new Error("onboarding attached no database");
      }
      const settings = await readGeneralSettings(storage, context.boot);
      expect(settings.database.backend).toBe("postgres");
      await scratch.cleanup();
    }
  );

  test.if(onPostgres)(
    "a database with Raaqeb tables and no record is refused and left alone",
    async () => {
      const scratch = await scratchDatabase();
      await runSql(scratch.location, "CREATE TABLE settings (id integer)");
      const { attached, context } = await fresh();
      expect(
        await chooseDatabase(
          { backend: "postgres", url: fixtureUrl() ?? "" },
          context
        )
      ).toEqual({ ok: false, reason: "refused" });
      expect(attached()).toBeUndefined();
      const rows = await runSql(
        scratch.location,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
      );
      expect(rows).toEqual([{ table_name: "settings" }]);
    }
  );
});

describe("choosing Postgres, with the opener answering by hand", () => {
  /** An opener that answers a fixed verdict and a fixed open result, so the config.json handling is pinned on both backends. */
  function stubOpener(
    verdict: Awaited<ReturnType<OnboardingContext["opener"]["test"]>>,
    open: Awaited<ReturnType<OnboardingContext["opener"]["open"]>>
  ): OnboardingContext["opener"] {
    return {
      open: () => Promise.resolve(open),
      test: () => Promise.resolve(verdict),
    };
  }

  test("a verdict the screen refuses is refused before anything is written", async () => {
    const { context, dataDir } = await fresh();
    const before = await Bun.file(`${dataDir}/config.json`).text();
    const result = await chooseDatabase(
      { backend: "postgres", url: "postgres://u:p@db.example/raaqeb" },
      {
        ...context,
        opener: stubOpener(
          { kind: "unrecorded" },
          { message: "never", ok: false }
        ),
      }
    );
    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(await Bun.file(`${dataDir}/config.json`).text()).toBe(before);
  });

  test("when the open fails after the URL was written, config.json is put back so the next boot does not meet it", async () => {
    const { context, dataDir } = await fresh();
    const before = await Bun.file(`${dataDir}/config.json`).text();
    const result = await chooseDatabase(
      { backend: "postgres", url: "postgres://u:p@db.example/raaqeb" },
      {
        ...context,
        opener: stubOpener(
          { kind: "empty" },
          { message: "migration 0001 failed", ok: false }
        ),
      }
    );
    expect(result).toEqual({ ok: false, reason: "open_failed" });
    expect(await Bun.file(`${dataDir}/config.json`).text()).toBe(before);
  });

  test("the URL is in config.json by the time the open runs, encrypted", async () => {
    const { context, dataDir } = await fresh();
    const url = "postgres://u:p@db.example/raaqeb";
    let seen: string | undefined;
    const result = await chooseDatabase(
      { backend: "postgres", url },
      {
        ...context,
        opener: {
          open: async () => {
            const file = await readConfigFile(dataDir);
            seen = file.ok ? file.config.databaseUrl : undefined;
            return { message: "stop here", ok: false };
          },
          test: () => Promise.resolve({ kind: "empty" }),
        },
      }
    );
    expect(result.ok).toBe(false);
    expect(seen).toBeDefined();
    expect(await decrypt(context.boot.installKey, seen ?? "")).toBe(url);
  });
});

describe("creating the operator account", () => {
  test("stores the install language and the public address, creates the account and signs it in", async () => {
    const { context, storage } = await opened();
    const result = await createOperatorAccount(
      account,
      context,
      at(account.publicAddress)
    );
    expect(result.ok).toBe(true);
    expect(await storage.settings.get(installLanguage)).toBe("en");
    expect(await storage.settings.get(publicAddress)).toBe(
      "http://status.example.com"
    );
    expect(await storage.operatorAccount.exists()).toBe(true);
    const cookies = result.ok ? result.setCookies : [];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toStartWith("raaqeb.session_token=");
    const auth = await authFor(storage, context.boot);
    const session = await readOperator(
      auth,
      new Headers({ cookie: cookies[0]?.split(";")[0] ?? "" })
    );
    expect(session?.operator.email).toBe(account.email);
  });

  test("moves the change counter, so the memo reads the public address it stored", async () => {
    const { context, storage } = await opened();
    const before = await storage.changeCounter();
    await createOperatorAccount(account, context, at(account.publicAddress));
    expect(await storage.changeCounter()).toBeGreaterThan(before);
  });

  test("the session cookie is Secure when the public address is https, because the address is stored before the instance is built", async () => {
    const { context } = await opened();
    const result = await createOperatorAccount(
      { ...account, publicAddress: "https://status.example.test" },
      context,
      at("https://status.example.test")
    );
    expect(result.ok ? result.setCookies[0] : "").toContain("Secure");
  });

  test("a second account is refused and nothing changes", async () => {
    const { context, storage } = await opened();
    await createOperatorAccount(account, context, at(account.publicAddress));
    const again = await createOperatorAccount(
      { ...account, email: "second@example.com", locale: "ar" },
      context,
      at(account.publicAddress)
    );
    expect(again).toEqual({ ok: false, reason: "already_exists" });
    expect(await storage.settings.get(installLanguage)).toBe("en");
  });

  test("two creations at once make one account; the other is refused", async () => {
    const { context, storage } = await opened();
    const [first, second] = await Promise.all([
      createOperatorAccount(account, context, at(account.publicAddress)),
      createOperatorAccount(
        { ...account, email: "second@example.com" },
        context,
        at(account.publicAddress)
      ),
    ]);
    expect([first.ok, second.ok].toSorted()).toEqual([false, true]);
    expect(first.ok ? second : first).toEqual({
      ok: false,
      reason: "already_exists",
    });
    expect(await storage.operatorAccount.exists()).toBe(true);
  });

  test("is refused with no database open", async () => {
    const { context } = await fresh();
    expect(
      await createOperatorAccount(account, context, at(account.publicAddress))
    ).toEqual({
      ok: false,
      reason: "no_database",
    });
  });

  test("a database that cannot answer is unavailable, never a throw", async () => {
    const { context, storage } = await opened();
    await storage.close();
    expect(
      await createOperatorAccount(account, context, at(account.publicAddress))
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("a public address the browser is not at", () => {
  test("is refused until the operator confirms it, and nothing is stored: sign-in would be refused from where the operator stands", async () => {
    const { context, storage } = await opened();
    expect(
      await createOperatorAccount(
        account,
        context,
        at("https://status.example.com")
      )
    ).toEqual({ ok: false, reason: "address_elsewhere" });
    expect(await storage.settings.get(publicAddress)).toBeUndefined();
    expect(await storage.settings.get(installLanguage)).toBeUndefined();
    expect(await storage.operatorAccount.exists()).toBe(false);
  });

  test("is stored once confirmed: onboarding over a tunnel or at localhost before DNS is fair", async () => {
    const { context, storage } = await opened();
    const result = await createOperatorAccount(
      { ...account, addressConfirmed: true },
      context,
      at("http://localhost:3000")
    );
    expect(result.ok).toBe(true);
    expect(await storage.settings.get(publicAddress)).toBe(
      account.publicAddress
    );
    expect(await storage.operatorAccount.exists()).toBe(true);
  });

  test("an install that already has its account says so, whatever the address", async () => {
    const { context } = await opened();
    await createOperatorAccount(account, context, at(account.publicAddress));
    expect(
      await createOperatorAccount(
        account,
        context,
        at("https://elsewhere.example")
      )
    ).toEqual({ ok: false, reason: "already_exists" });
  });

  test("is refused until confirmed when the request names no origin: nothing shows sign-in will work", async () => {
    const { context, storage } = await opened();
    expect(
      await createOperatorAccount(account, context, new Headers())
    ).toEqual({
      ok: false,
      reason: "address_elsewhere",
    });
    expect(await storage.operatorAccount.exists()).toBe(false);
  });
});

describe("the suggested public address", () => {
  test("is the origin the entry resolved behind the trusted proxies", () => {
    expect(
      suggestedPublicAddress(
        new Headers({
          "x-raaqeb-request-origin": "https://status.example.test",
        })
      )
    ).toBe("https://status.example.test");
  });

  test("is nothing when the entry wrote none: never a value the client chose", () => {
    expect(suggestedPublicAddress(new Headers({ host: "evil.example" }))).toBe(
      ""
    );
  });
});
