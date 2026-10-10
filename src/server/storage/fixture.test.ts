import { describe, expect, test } from "bun:test";
import { fixtureBackend } from "./fixture.ts";

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
