import { describe, expect, test } from "bun:test";
import { emailDarkQuery } from "@/shared/schemas/channel.ts";
import { emailInTheme } from "./email-theme.ts";

const html = `<style>\n.fg { color:#171717; }\n${emailDarkQuery} {\n  .fg { color:#fafafa !important; }\n}\n</style><p class="fg">x</p>`;

describe("an email in the admin's theme", () => {
  test("a dark admin shows the email's dark colours whatever the system prefers", () => {
    const shown = emailInTheme(html, "dark");
    expect(shown).not.toContain(emailDarkQuery);
    expect(shown).toContain(
      "@media all {\n  .fg { color:#fafafa !important; }"
    );
  });

  test("a light admin shows its light colours whatever the system prefers", () => {
    const shown = emailInTheme(html, "light");
    expect(shown).not.toContain(emailDarkQuery);
    expect(shown).toContain(
      "@media not all {\n  .fg { color:#fafafa !important; }"
    );
  });

  test("an admin that follows the system leaves the email to the system too", () => {
    expect(emailInTheme(html, "system")).toBe(html);
  });

  test("changes nothing but the query, so the email reads as sent", () => {
    expect(
      emailInTheme(html, "dark").replace("@media all", emailDarkQuery)
    ).toBe(html);
  });
});
