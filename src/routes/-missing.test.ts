import { describe, expect, test } from "bun:test";
import { missingInShell } from "./-missing.tsx";

describe("a not-found", () => {
  test("inside the admin keeps the shell and gets its page frame, a title and a way back", () => {
    expect(missingInShell("/admin")).toBe(true);
    expect(missingInShell("/admin/monitors/$id/")).toBe(true);
    expect(missingInShell("/admin/settings/storage")).toBe(true);
  });

  test("anywhere else is the visitor's, framed by its status page or bare", () => {
    expect(missingInShell("/{-$locale}/incidents/$id")).toBe(false);
    expect(missingInShell("/subscriptions/$token/")).toBe(false);
    expect(missingInShell("__root__")).toBe(false);
    expect(missingInShell("/administrator")).toBe(false);
  });
});
