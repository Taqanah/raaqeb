import { describe, expect, test } from "bun:test";
import { errorPlace } from "./-error.tsx";

describe("a route that failed", () => {
  test("in the admin shows its error in the shell's page area, so the sidebar stays", () => {
    expect(errorPlace("/admin/monitors/$id/")).toBe("shell");
    expect(errorPlace("/admin/channels/")).toBe("shell");
  });

  test("under the settings shows it inside the settings page's own frame, never a second title row", () => {
    expect(errorPlace("/admin/settings/storage")).toBe("page");
  });

  test("being the shell's own read shows it alone on the document: there is no shell to frame it", () => {
    expect(errorPlace("/admin")).toBe("document");
  });

  test("outside the admin shows it alone on the document, in the catalog's words like the admin's", () => {
    expect(errorPlace("/sign-in")).toBe("document");
    expect(errorPlace("/onboarding/account")).toBe("document");
    expect(errorPlace("/subscriptions/$token/")).toBe("document");
    expect(errorPlace("__root__")).toBe("document");
    expect(errorPlace("/administrator")).toBe("document");
  });
});
