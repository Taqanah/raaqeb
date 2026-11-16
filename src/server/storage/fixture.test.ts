import { afterEach, describe, expect, test } from "bun:test";
import { fixtureBackend, runSql, scratchDatabase } from "./fixture.ts";

describe("which backend the tests target", () => {
  test("the boot setting DATABASE_URL never turns a test run onto a real database", () => {
    expect(
      fixtureBackend({ DATABASE_URL: "postgres://raaqeb:pw@db.example/prod" })
    ).toBe("sqlite");
  });

  test("the Postgres run names its database in its own variable", () => {
    expect(
      fixtureBackend({
        RAAQEB_TEST_DATABASE_URL:
          "postgres://raaqeb:raaqeb@localhost:5432/raaqeb",
      })
    ).toBe("postgres");
  });
});

describe("a raw statement on the scratch database", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  test("answers a millisecond timestamp and a count as numbers, with `?` for each parameter, on either backend", async () => {
    const { cleanup: remove, location } = await scratchDatabase();
    cleanup = remove;
    const at = 1_700_000_060_000;
    const rows = await runSql(
      location,
      "SELECT CAST(? AS BIGINT) AS at, count(*) AS n, ? AS word",
      [at, "x"]
    );
    expect(rows).toEqual([{ at, n: 1, word: "x" }]);
  });
});
